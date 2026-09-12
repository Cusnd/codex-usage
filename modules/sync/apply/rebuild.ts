import { stableJson, type UploadBatch } from '../../contracts/sync.js';
import type { CanonicalEvent, ThreadChange } from "../../usage/types.js";
import { HttpError, sha256 } from "../../platform/worker/http.js";
import { metricStatements } from "../publication/metrics.js";
import { chunks, currentDevice, domain, endGuard, guard, type Domain, type EntityMutation, type JobLease, type WriteDevice } from "../publication/store.js";
import type { Job } from "../jobs/types.js";
import { assignmentRules, effectiveOrigin, withAssignment } from "../../organization/worker/origin-rules.js";
import { reconcileOriginEvidence } from "../../usage/origin-evidence.js";
import type { CandidateRow } from "../../usage/candidate-row.js";
import { canonicalFromRows } from "./canonical.js";

export type RebuildCheckpoint={phase:'events'|'threads'|'metadata'|'publish';epoch:string;last?:string};

type SourcePlan={collector_id:string;source_id:string;generation:number;payload:string|null};

const parsedFields=['observation_id','uploader_device_id','collector_id','source_id','generation','record_revision','event_id','thread_id','turn_id','at','signature','active','candidate','origin_claim'];

/** The proposed candidate set combines unchanged current facts with private source/record overlays. */
export function proposedCandidates():string {
  return `WITH scope AS(SELECT ? user_id,? job_id), plans AS(SELECT p.* FROM v3_rebuild_sources p JOIN scope x ON p.user_id=x.user_id AND p.job_id=x.job_id),
    overlays AS(SELECT o.* FROM v3_rebuild_candidates o JOIN scope x ON o.user_id=x.user_id AND o.job_id=x.job_id),
    proposed AS(SELECT ${parsedFields.map(f=>'c.'+f).join(',')} FROM v3_candidates c CROSS JOIN scope x LEFT JOIN plans p ON p.collector_id=c.collector_id AND p.source_id=c.source_id WHERE c.user_id=x.user_id AND CASE WHEN p.source_id IS NULL THEN c.active=1 ELSE c.generation=p.generation AND COALESCE(json_extract(p.payload,'$.active'),1)=1 END AND NOT EXISTS(SELECT 1 FROM v3_rebuild_candidates o WHERE o.user_id=x.user_id AND o.job_id=x.job_id AND o.observation_id=c.observation_id)
    UNION ALL SELECT ${parsedFields.map(f=>f==='event_id'?'event_id':`json_extract(payload,'$.${f}') ${f}`).join(',')} FROM overlays WHERE payload IS NOT NULL AND json_extract(payload,'$.active')=1),
    candidates AS(SELECT * FROM proposed WHERE COALESCE(json_extract(candidate,'$.excluded'),0)=0)`;
}

export function stageCandidateStatements(db:D1Database,user:string,job:string,rows:Map<string,CandidateRow|null>):D1PreparedStatement[] {
  return chunks([...rows].map(([id,r])=>({id,event:r?.event_id??null,payload:r?stableJson(r):null}))).map(group=>db.prepare(`INSERT INTO v3_rebuild_candidates(user_id,job_id,observation_id,event_id,payload) SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.event'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT(user_id,job_id,observation_id) DO UPDATE SET event_id=excluded.event_id,payload=excluded.payload`).bind(user,job,stableJson(group)));
}

export function stageSourceStatements(db:D1Database,user:string,job:string,rows:SourcePlan[]):D1PreparedStatement[] {
  return chunks(rows).map(group=>db.prepare(`INSERT INTO v3_rebuild_sources(user_id,job_id,collector_id,source_id,generation,payload) SELECT ?,?,json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT(user_id,job_id,collector_id,source_id) DO UPDATE SET generation=excluded.generation,payload=excluded.payload`).bind(user,job,stableJson(group)));
}

export async function startReplacement(db:D1Database,h:Domain,device:WriteDevice,b:UploadBatch,job:JobLease|undefined,sources:{source_id:string;generation:number;[key:string]:unknown}[],candidates:Map<string,CandidateRow|null>,threads:{source_id:string;generation:number;thread_id:string;payload:string}[]) {
  const id='apply:'+b.batch_id,op=crypto.randomUUID(),checkpoint:RebuildCheckpoint={phase:'events',epoch:crypto.randomUUID()};
  const statements=[guard(db,h,op,device,job),...stageSourceStatements(db,h.user_id,id,sources.map(s=>({collector_id:typeof s.collector_id==='string'?s.collector_id:b.collector_id,source_id:s.source_id,generation:s.generation,payload:stableJson(s)}))),...stageCandidateStatements(db,h.user_id,id,candidates)];
  for(const rows of chunks(threads))statements.push(db.prepare(`INSERT INTO v3_rebuild_threads(user_id,job_id,collector_id,source_id,generation,thread_id,payload) SELECT ?,?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.thread_id'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(h.user_id,id,b.collector_id,stableJson(rows)));
  statements.push(db.prepare("UPDATE v3_jobs SET kind='rebuild',checkpoint=?,state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0 WHERE user_id=? AND job_id=?").bind(stableJson(checkpoint),h.user_id,id),db.prepare("UPDATE v3_sync_domains SET mode='rebuilding',rebuild_job=?,write_version=write_version+1 WHERE user_id=?").bind(id,h.user_id),endGuard(db,h.user_id,op));await db.batch(statements);
}

export async function stagedEntities(db:D1Database,h:Domain,epoch:string,changes:EntityMutation[]):Promise<D1PreparedStatement[]> {
  const rows=await Promise.all(changes.map(async c=>({...c,payload:stableJson(c.value),hash:await sha256(stableJson(c.value))})));
  return chunks(rows).map(group=>db.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,at,thread_id,origin_device_id,payload) SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),0,json_extract(value,'$.revision'),json_extract(value,'$.hash'),json_extract(value,'$.at'),json_extract(value,'$.thread_id'),json_extract(value,'$.origin_device_id'),json_extract(value,'$.payload') FROM json_each(?)`).bind(h.user_id,epoch,stableJson(group)));
}

async function eventStep(db:D1Database,h:Domain,job:Job,c:RebuildCheckpoint):Promise<D1PreparedStatement[]> {
  // Each indexed branch contributes at most one page. An outer DISTINCT over the
  // entire proposed UNION makes SQLite scan/sort the remaining history per page.
  const current=`SELECT DISTINCT c.event_id FROM v3_candidates c LEFT JOIN v3_rebuild_sources p ON p.user_id=c.user_id AND p.job_id=? AND p.collector_id=c.collector_id AND p.source_id=c.source_id WHERE c.user_id=? AND c.event_id>? AND CASE WHEN p.source_id IS NULL THEN c.active=1 ELSE c.generation=p.generation AND COALESCE(json_extract(p.payload,'$.active'),1)=1 END AND COALESCE(json_extract(c.candidate,'$.excluded'),0)=0 AND NOT EXISTS(SELECT 1 FROM v3_rebuild_candidates o WHERE o.user_id=c.user_id AND o.job_id=? AND o.observation_id=c.observation_id) ORDER BY c.event_id LIMIT 100`;
  const staged=`SELECT DISTINCT event_id FROM v3_rebuild_candidates WHERE user_id=? AND job_id=? AND event_id>? AND payload IS NOT NULL AND json_extract(payload,'$.active')=1 AND COALESCE(json_extract(json_extract(payload,'$.candidate'),'$.excluded'),0)=0 ORDER BY event_id LIMIT 100`;
  const ids=(await db.prepare(`SELECT event_id FROM (${current}) UNION SELECT event_id FROM (${staged}) ORDER BY event_id LIMIT 100`).bind(job.job_id,h.user_id,c.last||'',job.job_id,h.user_id,job.job_id,c.last||'').all<{event_id:string}>()).results.map(r=>r.event_id);
  if(!ids.length){c.phase='threads';delete c.last;return [];}
  const [loaded,rules]=await Promise.all([db.batch([
    db.prepare(proposedCandidates()+` SELECT * FROM candidates WHERE event_id IN(SELECT value FROM json_each(?))`).bind(h.user_id,job.job_id,stableJson(ids)),
    db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND active=1 AND event_id IN(SELECT value FROM json_each(?))').bind(h.user_id,stableJson(ids)),
    db.prepare("SELECT entity_id,payload,revision FROM v3_entity_versions WHERE user_id=? AND epoch=? AND kind='event' AND valid_to IS NULL AND entity_id IN(SELECT value FROM json_each(?))").bind(h.user_id,h.active_epoch,stableJson(ids)),
  ]),assignmentRules(db,h.user_id,ids)]);
  const rows=(loaded[0].results as CandidateRow[]).map(r=>({...r,active:1})),prior=loaded[1].results as CandidateRow[],old=loaded[2].results as {entity_id:string;payload:string|null;revision:number}[];
  const turns=[...new Set(rows.filter(r=>r.turn_id!==null&&JSON.parse(r.candidate).kind!=='record').map(r=>stableJson([r.thread_id,r.turn_id])))].map(v=>JSON.parse(v));
  const explicit=turns.length?(await db.prepare(proposedCandidates()+` SELECT DISTINCT thread_id,turn_id FROM candidates WHERE json_extract(candidate,'$.kind')='record' AND EXISTS(SELECT 1 FROM json_each(?) p WHERE thread_id=json_extract(p.value,'$[0]') AND turn_id=json_extract(p.value,'$[1]'))`).bind(h.user_id,job.job_id,stableJson(turns)).all<{thread_id:string;turn_id:string}>()).results:[],explicitTurns=new Set(explicit.map(r=>stableJson([r.thread_id,r.turn_id])));
  const allowed=new Set(rows.filter(r=>JSON.parse(r.candidate).kind==='record'||r.turn_id===null||!explicitTurns.has(stableJson([r.thread_id,r.turn_id]))).map(r=>r.observation_id)),values:CanonicalEvent[]=[],originUpdates=new Map<string,CandidateRow|null>();
  const grouped=new Map<string,CandidateRow[]>(),priorGrouped=new Map<string,CandidateRow[]>();
  for(const r of rows)if(allowed.has(r.observation_id)){if(!grouped.has(r.event_id))grouped.set(r.event_id,[]);grouped.get(r.event_id)!.push(r);}
  for(const r of prior){if(!priorGrouped.has(r.event_id))priorGrouped.set(r.event_id,[]);priorGrouped.get(r.event_id)!.push(r);}
  for(const id of ids){const original=grouped.get(id)||[],byObservation=new Map(original.map(r=>[r.observation_id,r])),group=reconcileOriginEvidence(original,priorGrouped.get(id)||[]);
    for(const r of group)if(r.candidate!==byObservation.get(r.observation_id)!.candidate)originUpdates.set(r.observation_id,r);
    const value=await canonicalFromRows(group);if(value)values.push(value);
  }
  for(let i=0;i<values.length;i++)values[i]=withAssignment(values[i],rules.get(values[i].event_id)??null)!;
  const oldById=new Map(old.map(r=>[r.entity_id,r]));
  const changes:EntityMutation[]=values.map(value=>{const before=oldById.get(value.event_id);return {kind:'event',id:value.event_id,value,revision:(before?.revision||0)+Number(before?.payload!==stableJson(value)),at:value.at,thread_id:value.thread_id,origin_device_id:effectiveOrigin(value)};}),out=await stagedEntities(db,h,c.epoch,changes);
  for(const group of chunks(changes.map(v=>({revision:v.revision,...v.value as CanonicalEvent,origin_device_id:v.origin_device_id,payload:stableJson(v.value)}))))out.push(db.prepare(`INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,turn_id,origin_device_id,source_project_id,project,model,effort,payload) SELECT ?,?,json_extract(value,'$.event_id'),json_extract(value,'$.revision'),json_extract(value,'$.at'),json_extract(value,'$.thread_id'),json_extract(value,'$.turn_id'),json_extract(value,'$.origin_device_id'),json_extract(value,'$.source_project_id'),json_extract(value,'$.project'),json_extract(value,'$.model'),json_extract(value,'$.effort'),json_extract(value,'$.payload') FROM json_each(?)`).bind(h.user_id,c.epoch,stableJson(group)));
  out.push(...await metricStatements(db,{...h,active_epoch:c.epoch},values.map(after=>({event_id:after.event_id,before:null,after}))));
  out.push(...stageCandidateStatements(db,h.user_id,job.job_id,originUpdates));
  c.last=ids.at(-1);return out;
}

function proposedThreads():string {
  return `WITH scope AS(SELECT ? user_id,? job_id), plans AS(SELECT p.* FROM v3_rebuild_sources p JOIN scope x ON p.user_id=x.user_id AND p.job_id=x.job_id),
    overlays AS(SELECT t.* FROM v3_rebuild_threads t JOIN scope x ON t.user_id=x.user_id AND t.job_id=x.job_id LEFT JOIN plans p ON p.collector_id=t.collector_id AND p.source_id=t.source_id WHERE COALESCE(json_extract(p.payload,'$.active'),1)=1),
    selected AS(SELECT t.collector_id,t.source_id,t.generation,t.thread_id,t.payload FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) CROSS JOIN scope x LEFT JOIN plans p ON p.collector_id=t.collector_id AND p.source_id=t.source_id WHERE t.user_id=x.user_id AND CASE WHEN p.source_id IS NULL THEN s.active=1 ELSE t.generation=p.generation AND COALESCE(json_extract(p.payload,'$.active'),1)=1 END AND NOT EXISTS(SELECT 1 FROM overlays o WHERE (o.collector_id,o.source_id,o.generation,o.thread_id)=(t.collector_id,t.source_id,t.generation,t.thread_id)) UNION ALL SELECT collector_id,source_id,generation,thread_id,payload FROM overlays)`;
}

async function threadStep(db:D1Database,h:Domain,job:Job,c:RebuildCheckpoint):Promise<D1PreparedStatement[]> {
  const ids=(await db.prepare(proposedThreads()+' SELECT DISTINCT thread_id FROM selected WHERE thread_id>? ORDER BY thread_id LIMIT 100').bind(h.user_id,job.job_id,c.last||'').all<{thread_id:string}>()).results.map(r=>r.thread_id);
  if(!ids.length){c.phase='metadata';delete c.last;return [];}
  const rows=(await db.prepare(proposedThreads()+' SELECT thread_id,payload FROM selected WHERE thread_id IN(SELECT value FROM json_each(?)) ORDER BY collector_id,source_id,generation').bind(h.user_id,job.job_id,stableJson(ids)).all<{thread_id:string;payload:string}>()).results,changes:EntityMutation[]=[];
  const previous=(await db.prepare('SELECT thread_id,payload,revision FROM v3_threads WHERE user_id=? AND thread_id IN(SELECT value FROM json_each(?))').bind(h.user_id,stableJson(ids)).all<{thread_id:string;payload:string;revision:number}>()).results,oldById=new Map(previous.map(r=>[r.thread_id,r])),grouped=new Map<string,ThreadChange[]>();
  for(const r of rows){if(!grouped.has(r.thread_id))grouped.set(r.thread_id,[]);grouped.get(r.thread_id)!.push(JSON.parse(r.payload));}
  for(const id of ids){let value:ThreadChange|undefined;for(const t of grouped.get(id)||[]){if(!value)value=t;else if(t.title!==undefined){if((t.title_updated_at||'')>=(value.title_updated_at||''))value={...value,title:t.title,title_updated_at:t.title_updated_at};}else value={...value,...t};}
    if(value){const old=oldById.get(id);changes.push({kind:'thread',id,value,thread_id:id,revision:(old?.revision||0)+Number(old?.payload!==stableJson(value))});}}
  c.last=ids.at(-1);return stagedEntities(db,h,c.epoch,changes);
}

async function metadataStep(db:D1Database,h:Domain,c:RebuildCheckpoint):Promise<D1PreparedStatement[]> {
  const rows=(await db.prepare("SELECT kind,entity_id FROM v3_entity_versions WHERE user_id=? AND epoch=? AND valid_to IS NULL AND payload IS NOT NULL AND kind NOT IN('event','thread') AND (kind||':'||entity_id)>? ORDER BY kind||':'||entity_id LIMIT 200").bind(h.user_id,h.active_epoch,c.last||'').all<{kind:string;entity_id:string}>()).results;
  if(!rows.length){c.phase='publish';delete c.last;return [];}
  c.last=rows.at(-1)!.kind+':'+rows.at(-1)!.entity_id;
  return [db.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,at,thread_id,origin_device_id,payload) SELECT user_id,?,kind,entity_id,0,revision,hash,at,thread_id,origin_device_id,payload FROM v3_entity_versions WHERE user_id=? AND epoch=? AND valid_to IS NULL AND payload IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(?) j WHERE kind=json_extract(j.value,'$.kind') AND entity_id=json_extract(j.value,'$.entity_id'))`).bind(c.epoch,h.user_id,h.active_epoch,stableJson(rows))];
}

export function rebuildCleanup(db:D1Database,user:string,job:string):D1PreparedStatement[]{return ['v3_rebuild_candidates','v3_rebuild_sources','v3_rebuild_threads','v3_rebuild_origins'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND job_id=?`).bind(user,job));}

export function rebuildPublication(db:D1Database,h:Domain,job:string,epoch:string):D1PreparedStatement[]{return [
  db.prepare('DELETE FROM v3_threads WHERE user_id=?').bind(h.user_id),db.prepare("INSERT INTO v3_threads(user_id,thread_id,payload,revision) SELECT user_id,entity_id,payload,revision FROM v3_entity_versions WHERE user_id=? AND epoch=? AND kind='thread' AND valid_to IS NULL AND payload IS NOT NULL").bind(h.user_id,epoch),
  db.prepare(`UPDATE v3_candidates SET candidate=(SELECT json_extract(o.payload,'$.candidate') FROM v3_rebuild_candidates o WHERE o.user_id=v3_candidates.user_id AND o.job_id=? AND o.observation_id=v3_candidates.observation_id) WHERE user_id=? AND observation_id IN(SELECT observation_id FROM v3_rebuild_candidates WHERE user_id=? AND job_id=? AND payload IS NOT NULL)`).bind(job,h.user_id,h.user_id,job),
  db.prepare("UPDATE v3_sync_domains SET active_epoch=?,commit_seq=0,changes_floor=0,mode='ready',rebuild_job=NULL WHERE user_id=? AND rebuild_job=?").bind(epoch,h.user_id,job),
  ...rebuildCleanup(db,h.user_id,job),
];}

export async function advanceRebuild(db:D1Database,job:Job,publish:(h:Domain,c:RebuildCheckpoint)=>Promise<boolean>,loadedDomain?:Domain):Promise<boolean> {
  // A caller may share its just-read domain. The final guard still compares this
  // exact epoch/write_version, so concurrent changes cannot publish stale work.
  const h=loadedDomain??await domain(db,job.user_id),c=JSON.parse(job.checkpoint) as RebuildCheckpoint;if(h.mode!=='rebuilding'||h.rebuild_job!==job.job_id)throw new HttpError(409,'REBUILD_SUPERSEDED','重建已被其他操作替代。');
  const device=job.device_id?await currentDevice(db,h.user_id,job.device_id):undefined;
  if(c.phase==='publish')return publish(h,c);
  const statements=c.phase==='events'?await eventStep(db,h,job,c):c.phase==='threads'?await threadStep(db,h,job,c):await metadataStep(db,h,c),op=crypto.randomUUID();
  await db.batch([guard(db,h,op,device,job),...statements,db.prepare("UPDATE v3_jobs SET checkpoint=?,state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(stableJson(c),Date.now(),job.user_id,job.job_id),endGuard(db,h.user_id,op)]);return false;
}
