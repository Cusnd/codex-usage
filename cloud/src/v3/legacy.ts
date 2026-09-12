import { stableJson,type UploadBatch,type LegacyHandoffResult } from '../../../shared/sync-v3';
import { initialContext } from '../../../shared/usage-domain/normalize';
import { TOKEN_FIELDS,type Candidate,type ThreadChange } from '../../../shared/usage-domain/types';
import type { SyncManifest } from '../../../shared/usage-sync';
import { fail,sha256 } from '../http';
import type { CandidateRow } from './apply';
import { advanceHead,chunks,domain,endGuard,entityStatements,guard,type Domain,type WriteDevice } from './store';
import { advanceRebuild,rebuildCleanup,rebuildPublication,stageCandidateStatements,stageSourceStatements } from './rebuild';
import { prepareLegacyProjects } from './projects';
import type { Job } from './jobs';

type LegacyHead={user_id:string;device_id:string;dataset_id:string;thread_id:string;revision:number;manifest:string;collector_id:string;source_id:string};

const sourceId=async(dataset:string,thread:string)=>'legacy:'+await sha256(stableJson([dataset,thread]));
export async function prepareHandoff(db:D1Database,h:Domain,device:WriteDevice,b:UploadBatch) {
  const replacements=b.metadata.filter(m=>m.type==='legacy_replacement'),outcomes:LegacyHandoffResult[]=[],statements:D1PreparedStatement[]=[];
  type Plan={collector_id:string;source_id:string;generation:number;payload:null};
  const plans=new Map<string,Plan>();
  if(!replacements.length)return {plans:[],statements,outcomes};
  const key=(dataset:string,thread:string)=>stableJson([dataset,thread]),planKey=(collector:string,source:string)=>stableJson([collector,source]);
  type Head={dataset_id:string;thread_id:string;revision:number;collector_id:string|null;source_id:string|null;retired_revision:number|null};
  const requestedHeads=[...new Map(replacements.map(m=>[key(m.dataset_id,m.thread_id),{dataset_id:m.dataset_id,thread_id:m.thread_id}])).values()],heads=new Map<string,Head>();
  for(const group of chunks(requestedHeads)){
    const rows=(await db.prepare(`SELECT h.dataset_id,h.thread_id,h.revision,l.collector_id,l.source_id,l.retired_revision FROM json_each(?) m JOIN usage_heads h ON h.user_id=? AND h.device_id=? AND h.dataset_id=json_extract(m.value,'$.dataset_id') AND h.thread_id=json_extract(m.value,'$.thread_id') LEFT JOIN v3_legacy_heads l USING(user_id,device_id,dataset_id,thread_id)`).bind(stableJson(group),h.user_id,device.id).all<Head>()).results;
    for(const row of rows)heads.set(key(row.dataset_id,row.thread_id),row);
  }
  const pending=replacements.filter(m=>{const head=heads.get(key(m.dataset_id,m.thread_id));return head&&(head.retired_revision||0)<head.revision;}),requests=[...new Map(pending.flatMap(m=>m.sources.map(s=>[stableJson([s.source_id,s.generation]),s] as const))).values()];
  type Source={source_id:string;generation:number;newest:number|null;complete:number|null;available:number|null;context:string|null};
  const sources=new Map<string,Source>();
  for(const group of chunks(requests)){
    const rows=(await db.prepare(`SELECT json_extract(j.value,'$.source_id') source_id,json_extract(j.value,'$.generation') generation,(SELECT MAX(n.generation) FROM v3_sources n WHERE n.user_id=? AND n.collector_id=? AND n.source_id=json_extract(j.value,'$.source_id')) newest,s.complete,s.available,s.context FROM json_each(?) j LEFT JOIN v3_sources s ON s.user_id=? AND s.collector_id=? AND s.source_id=json_extract(j.value,'$.source_id') AND s.generation=json_extract(j.value,'$.generation')`).bind(h.user_id,b.collector_id,stableJson(group),h.user_id,b.collector_id).all<Source>()).results;
    for(const row of rows)sources.set(stableJson([row.source_id,row.generation]),row);
  }
  const defaultIds=new Map(await Promise.all([...heads.values()].filter(head=>!head.source_id).map(async head=>[key(head.dataset_id,head.thread_id),await sourceId(head.dataset_id,head.thread_id)] as const))),promotions=new Map<string,{source_id:string;generation:number}>(),retirements=new Map<string,Head&{device_id:string;collector_id:string;source_id:string}>();
  for(const m of replacements){
    const head=heads.get(key(m.dataset_id,m.thread_id));
    if(!head||(head.retired_revision||0)>=head.revision){outcomes.push({dataset_id:m.dataset_id,thread_id:m.thread_id,status:'applied'});continue;}
    const selected=m.sources.map(s=>sources.get(stableJson([s.source_id,s.generation]))!);
    // A newer live generation makes this immutable backfill operation obsolete.
    if(selected.some(s=>(s.newest||0)>s.generation)){outcomes.push({dataset_id:m.dataset_id,thread_id:m.thread_id,status:'superseded'});continue;}
    if(selected.some(s=>s.complete!==1||s.available!==1||!s.context||JSON.parse(s.context).thread_id!==m.thread_id))fail(409,'LEGACY_REPLACEMENT_INCOMPLETE','旧历史替换必须等待对应原始来源完整应用。');
    outcomes.push({dataset_id:m.dataset_id,thread_id:m.thread_id,status:'applied'});
    const collector=head.collector_id||'legacy:'+device.id,source=head.source_id||defaultIds.get(key(m.dataset_id,m.thread_id))!;
    plans.set(planKey(collector,source),{collector_id:collector,source_id:source,generation:-1,payload:null});
    retirements.set(key(m.dataset_id,m.thread_id),{...head,device_id:device.id,collector_id:collector,source_id:source});
    for(const replacement of m.sources){if(!plans.has(planKey(b.collector_id,replacement.source_id)))plans.set(planKey(b.collector_id,replacement.source_id),{collector_id:b.collector_id,...replacement,payload:null});promotions.set(replacement.source_id,replacement);}
  }
  for(const group of chunks([...promotions.values()])){
    const raw=stableJson(group);
    // Clear the selected sources before changing generations to preserve the unique active-source index.
    statements.push(db.prepare(`UPDATE v3_sources SET active=0 WHERE user_id=? AND collector_id=? AND source_id IN(SELECT json_extract(value,'$.source_id') FROM json_each(?))`).bind(h.user_id,b.collector_id,raw));
    for(const table of ['v3_sources','v3_candidates'])statements.push(db.prepare(`UPDATE ${table} SET active=CASE WHEN generation=(SELECT json_extract(value,'$.generation') FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id')) THEN 1 ELSE 0 END WHERE user_id=? AND collector_id=? AND source_id IN(SELECT json_extract(value,'$.source_id') FROM json_each(?))`).bind(raw,h.user_id,b.collector_id,raw));
  }
  for(const group of chunks([...retirements.values()])){
    const raw=stableJson(group);
    statements.push(db.prepare(`INSERT INTO v3_legacy_heads(user_id,device_id,dataset_id,thread_id,retired_revision,collector_id,source_id) SELECT ?,json_extract(value,'$.device_id'),json_extract(value,'$.dataset_id'),json_extract(value,'$.thread_id'),json_extract(value,'$.revision'),json_extract(value,'$.collector_id'),json_extract(value,'$.source_id') FROM json_each(?) WHERE true ON CONFLICT(user_id,device_id,dataset_id,thread_id) DO UPDATE SET retired_revision=MAX(retired_revision,excluded.retired_revision)`).bind(h.user_id,raw));
    for(const table of ['v3_candidates','v3_observations','v3_source_threads','v3_deferred_records','v3_dependencies','v3_sources'])statements.push(db.prepare(`DELETE FROM ${table} WHERE rowid IN(SELECT t.rowid FROM json_each(?) j JOIN ${table} t ON t.user_id=? AND t.collector_id=json_extract(j.value,'$.collector_id') AND t.source_id=json_extract(j.value,'$.source_id'))`).bind(raw,h.user_id));
  }
  return {plans:[...plans.values()],statements,outcomes};
}
function insertStagedCandidates(db:D1Database,user:string,job:string):D1PreparedStatement {
  const fields=['observation_id','uploader_device_id','collector_id','source_id','generation','record_revision','event_id','thread_id','turn_id','at','signature','candidate','origin_claim'];
  return db.prepare(`INSERT INTO v3_candidates(user_id,${fields.join(',')},active) SELECT user_id,${fields.map(k=>`json_extract(payload,'$.${k}')`).join(',')},1 FROM v3_rebuild_candidates WHERE user_id=? AND job_id=? AND payload IS NOT NULL ON CONFLICT(user_id,observation_id) DO UPDATE SET candidate=excluded.candidate`).bind(user,job);
}
async function resetLegacyJob(db:D1Database,h:Domain,job:Job,epoch:string) {
  const op=crypto.randomUUID();await db.batch([guard(db,h,op,undefined,job),...['v3_events','v3_entity_versions','v3_aggregates','v3_aggregate_members'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=? AND epoch<>?`).bind(h.user_id,epoch,h.active_epoch)),...rebuildCleanup(db,h.user_id,job.job_id),db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(h.user_id,job.job_id),db.prepare("UPDATE v3_jobs SET payload='{}',checkpoint='{}',state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0 WHERE user_id=? AND job_id=?").bind(h.user_id,job.job_id),endGuard(db,h.user_id,op)]);
}

type BaselineCheckpoint={phase:'scan'|'import'|'events'|'threads'|'metadata'|'publish';epoch:string;last?:string;head_cursor?:[string,string,string];record_cursor?:[string,string,string]};
type StagedLegacy={device_id:string;dataset_id:string;thread_id:string;revision:number;project_id:string|null;project_name:string|null};
const pendingHeads=`FROM usage_heads h JOIN usage_revisions r USING(user_id,device_id,dataset_id,thread_id,revision) JOIN devices d ON d.id=h.device_id LEFT JOIN v3_legacy_heads l USING(user_id,device_id,dataset_id,thread_id) WHERE h.user_id=? AND r.committed=1 AND d.history_deleted_at IS NULL AND h.revision>COALESCE(l.imported_revision,0) AND h.revision>COALESCE(l.retired_revision,0)`;
const stagedLegacy=`SELECT p.*,json_extract(p.payload,'$._legacy.device_id') device_id,json_extract(p.payload,'$._legacy.dataset_id') dataset_id,json_extract(p.payload,'$._legacy.thread_id') thread_id FROM v3_rebuild_sources p WHERE p.user_id=? AND p.job_id=?`;
function checkpointStatement(db:D1Database,job:Job,c:BaselineCheckpoint) {return db.prepare("UPDATE v3_jobs SET checkpoint=?,state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(stableJson(c),Date.now(),job.user_id,job.job_id);}
/** The source snapshot is checked again before publication; v2 head triggers participate in the final domain CAS. */
async function snapshotChanged(db:D1Database,user:string,job:string):Promise<boolean>{
  const changed=await db.prepare(`WITH staged AS(${stagedLegacy}) SELECT 1 changed FROM staged s LEFT JOIN usage_heads h ON h.user_id=s.user_id AND h.device_id=s.device_id AND h.dataset_id=s.dataset_id AND h.thread_id=s.thread_id LEFT JOIN devices d ON d.id=s.device_id LEFT JOIN v3_legacy_heads l ON l.user_id=s.user_id AND l.device_id=s.device_id AND l.dataset_id=s.dataset_id AND l.thread_id=s.thread_id WHERE h.revision IS NOT s.generation OR d.history_deleted_at IS NOT NULL OR COALESCE(l.retired_revision,0)>=s.generation LIMIT 1`).bind(user,job).first();
  if(changed)return true;
  return !!await db.prepare(`WITH staged AS(${stagedLegacy}) SELECT 1 missing ${pendingHeads} AND NOT EXISTS(SELECT 1 FROM staged s WHERE s.device_id=h.device_id AND s.dataset_id=h.dataset_id AND s.thread_id=h.thread_id AND s.generation=h.revision) LIMIT 1`).bind(user,job,user).first();
}
/** Stage the complete committed legacy baseline, then materialize and publish it exactly once. */
export async function legacyStep(db:D1Database,job:Job):Promise<boolean> {
  const h=await domain(db,job.user_id),saved=JSON.parse(job.payload) as {format?:number;head?:LegacyHead},c=JSON.parse(job.checkpoint) as BaselineCheckpoint;
  // A deployed per-head job can resume safely: discard only its unpublished work.
  // Imported heads and the active epoch remain intact and join the new baseline.
  if(saved.head){await resetLegacyJob(db,h,job,c.epoch);return false;}
  if(saved.format!==2){
    if(h.mode!=='ready')return false;
    const any=await db.prepare(`SELECT 1 pending ${pendingHeads} LIMIT 1`).bind(h.user_id).first(),op=crypto.randomUUID();
    if(!any){await db.batch([guard(db,h,op,undefined,job),db.prepare('UPDATE v3_sync_domains SET legacy_baseline_pending=0,write_version=write_version+1 WHERE user_id=?').bind(h.user_id),db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),h.user_id,job.job_id),endGuard(db,h.user_id,op)]);return true;}
    const initial:BaselineCheckpoint={phase:'scan',epoch:crypto.randomUUID()};
    await db.batch([guard(db,h,op,undefined,job),db.prepare('UPDATE v3_jobs SET payload=? WHERE user_id=? AND job_id=?').bind(stableJson({format:2}),h.user_id,job.job_id),checkpointStatement(db,job,initial),db.prepare("UPDATE v3_sync_domains SET mode='rebuilding',rebuild_job=?,write_version=write_version+1 WHERE user_id=?").bind(job.job_id,h.user_id),endGuard(db,h.user_id,op)]);return false;
  }
  if(h.mode!=='rebuilding'||h.rebuild_job!==job.job_id){await resetLegacyJob(db,h,job,c.epoch);return false;}
  if(c.phase==='scan'){
    const cursor=c.head_cursor||['','',''],heads=(await db.prepare(`SELECT h.*,r.manifest ${pendingHeads} AND (h.device_id,h.dataset_id,h.thread_id)>(?,?,?) ORDER BY h.device_id,h.dataset_id,h.thread_id LIMIT 50`).bind(h.user_id,...cursor).all<LegacyHead>()).results;
    const staged=await Promise.all(heads.map(async head=>{
      const collector_id='legacy:'+head.device_id,source_id=await sourceId(head.dataset_id,head.thread_id),m=JSON.parse(head.manifest) as SyncManifest,project_id=m.thread.project?'legacy-project:'+await sha256(m.thread.project):null;
      const context={...initialContext(head.thread_id),cwd:m.thread.project,source_project_id:project_id},thread:ThreadChange={id:head.thread_id,title:m.thread.title,title_updated_at:m.thread.titleUpdatedAt,project:m.thread.project,source_project_id:project_id?'pc1:'+await sha256(stableJson([collector_id,project_id])):null,source:m.thread.source,parent_id:m.thread.parentId,subagent_parent_id:m.thread.subagentParentId,forked_from_id:m.thread.forkedFromId};
      const legacy:StagedLegacy={device_id:head.device_id,dataset_id:head.dataset_id,thread_id:head.thread_id,revision:head.revision,project_id,project_name:m.thread.project};
      const source={user_id:h.user_id,collector_id,source_id,generation:head.revision,kind:'session',cursor:m.eventCount,snapshot_eof:m.eventCount,context_hash:await sha256(stableJson(context)),context:stableJson(context),legacy_state:null,active:1,complete:1,available:1,trailing_bytes:0,_legacy:legacy};
      return {collector_id,source_id,generation:head.revision,payload:stableJson(source),device_id:head.device_id,thread_id:head.thread_id,thread:stableJson(thread)};
    }));
    if(heads.length){const last=heads.at(-1)!;c.head_cursor=[last.device_id,last.dataset_id,last.thread_id];}else{c.phase='import';delete c.head_cursor;}
    const op=crypto.randomUUID(),statements=[guard(db,h,op,undefined,job),...stageSourceStatements(db,h.user_id,job.job_id,staged)];
    for(const group of chunks(staged))statements.push(db.prepare(`INSERT INTO v3_rebuild_threads(user_id,job_id,collector_id,source_id,generation,thread_id,payload) SELECT ?,?,json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.thread_id'),json_extract(value,'$.thread') FROM json_each(?)`).bind(h.user_id,job.job_id,stableJson(group)));
    statements.push(checkpointStatement(db,job,c),endGuard(db,h.user_id,op));await db.batch(statements);return false;
  }
  if(c.phase==='import'){
    // Walk the staged-source primary key, then the exact committed record key.
    // The explicit lower bounds let both indexes skip already imported pages.
    const cursor=c.record_cursor||['','',''],rows=(await db.prepare(`WITH staged AS(${stagedLegacy}) SELECT r.event_key,r.device_id,r.dataset_id,r.thread_id,r.turn_id,r.response_id,r.at,r.project,r.model,r.effort,r.kind,r.incomplete,${TOKEN_FIELDS.map(f=>`CAST(r.${f} AS TEXT) ${f}`).join(',')},s.collector_id,s.source_id,s.generation,json_extract(s.payload,'$._legacy.project_id') project_id FROM staged s JOIN usage_records r ON r.user_id=s.user_id AND r.device_id=s.device_id AND r.dataset_id=s.dataset_id AND r.thread_id=s.thread_id AND r.revision=s.generation WHERE (s.collector_id,s.source_id)>=(?,?) AND r.event_key>CASE WHEN (s.collector_id,s.source_id)=(?,?) THEN ? ELSE '' END ORDER BY s.collector_id,s.source_id,r.event_key LIMIT 200`).bind(h.user_id,job.job_id,cursor[0],cursor[1],...cursor).all<Record<string,any>>()).results;
    const entries=await Promise.all(rows.map(async r=>{
      const observation=await sha256(stableJson(['v2',r.device_id,r.dataset_id,r.thread_id,r.generation,r.event_key])),event=r.response_id?'response:'+r.response_id:'v2:'+await sha256(stableJson([r.device_id,r.dataset_id,r.thread_id,r.event_key]));
      const candidate:Candidate={...Object.fromEntries(TOKEN_FIELDS.map(f=>[f,r[f]])),observation_id:observation,record_revision:1,source_id:r.source_id,generation:r.generation,event_id:event,thread_id:r.thread_id,turn_id:r.turn_id,response_id:r.response_id,at:r.at,project:r.project,source_project_id:r.project_id,model:r.model,effort:r.effort,kind:r.kind,signature:null,incomplete:!!r.incomplete,excluded:false,identity_quality:r.response_id?'response':'source_position',origin:{device_id:null,kind:'unknown'}} as Candidate;
      const row:CandidateRow={observation_id:observation,uploader_device_id:r.device_id,collector_id:r.collector_id,source_id:r.source_id,generation:r.generation,record_revision:1,event_id:event,thread_id:r.thread_id,turn_id:r.turn_id,at:r.at,signature:null,active:1,candidate:stableJson(candidate)};return [observation,row] as const;
    }));
    if(rows.length){const last=rows.at(-1)!;c.record_cursor=[last.collector_id,last.source_id,last.event_key];}else{if(await snapshotChanged(db,h.user_id,job.job_id)){await resetLegacyJob(db,h,job,c.epoch);return false;}c.phase='events';delete c.record_cursor;}
    const op=crypto.randomUUID();await db.batch([guard(db,h,op,undefined,job),...stageCandidateStatements(db,h.user_id,job.job_id,new Map(entries)),checkpointStatement(db,job,c),endGuard(db,h.user_id,op)]);return false;
  }
  return advanceRebuild(db,job,async(live,checkpoint)=>{
    if(await snapshotChanged(db,live.user_id,job.job_id)){await resetLegacyJob(db,live,job,checkpoint.epoch);return false;}
    const sources=(await db.prepare('SELECT collector_id,payload FROM v3_rebuild_sources WHERE user_id=? AND job_id=?').bind(h.user_id,job.job_id).all<{collector_id:string;payload:string}>()).results;
    const projects=await prepareLegacyProjects(db,live,sources.map(row=>({collector_id:row.collector_id,...JSON.parse(row.payload)._legacy as StagedLegacy}))),target={...live,active_epoch:checkpoint.epoch,commit_seq:0},op=crypto.randomUUID();
    const sourceFields=['collector_id','source_id','generation','kind','cursor','snapshot_eof','context_hash','context','legacy_state','active','complete','available','trailing_bytes'];
    const statements=[guard(db,live,op,undefined,job)];
    for(const table of ['v3_candidates','v3_source_threads','v3_sources'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND EXISTS(SELECT 1 FROM v3_rebuild_sources p WHERE p.user_id=${table}.user_id AND p.job_id=? AND p.collector_id=${table}.collector_id AND p.source_id=${table}.source_id)`).bind(h.user_id,job.job_id));
    statements.push(db.prepare(`INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) SELECT user_id,collector_id,json_extract(payload,'$._legacy.device_id'),? FROM v3_rebuild_sources WHERE user_id=? AND job_id=? GROUP BY collector_id ON CONFLICT DO NOTHING`).bind(Date.now(),h.user_id,job.job_id),db.prepare(`INSERT INTO v3_sources(user_id,${sourceFields.join(',')}) SELECT user_id,${sourceFields.map(k=>`json_extract(payload,'$.${k}')`).join(',')} FROM v3_rebuild_sources WHERE user_id=? AND job_id=?`).bind(h.user_id,job.job_id),insertStagedCandidates(db,h.user_id,job.job_id),db.prepare('INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) SELECT user_id,collector_id,source_id,generation,thread_id,payload FROM v3_rebuild_threads WHERE user_id=? AND job_id=?').bind(h.user_id,job.job_id),...projects.statements,...await entityStatements(db,target,projects.changes),db.prepare(`INSERT INTO v3_legacy_heads(user_id,device_id,dataset_id,thread_id,imported_revision,collector_id,source_id) SELECT user_id,json_extract(payload,'$._legacy.device_id'),json_extract(payload,'$._legacy.dataset_id'),json_extract(payload,'$._legacy.thread_id'),generation,collector_id,source_id FROM v3_rebuild_sources WHERE user_id=? AND job_id=? ON CONFLICT(user_id,device_id,dataset_id,thread_id) DO UPDATE SET imported_revision=excluded.imported_revision,collector_id=excluded.collector_id,source_id=excluded.source_id`).bind(h.user_id,job.job_id),...rebuildPublication(db,live,job.job_id,checkpoint.epoch),advanceHead(db,live,projects.changes.length>0),db.prepare('UPDATE v3_sync_domains SET legacy_baseline_pending=0 WHERE user_id=?').bind(h.user_id),db.prepare("UPDATE v3_jobs SET payload='{}',checkpoint='{}',state='complete',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),h.user_id,job.job_id),endGuard(db,h.user_id,op));
    await db.batch(statements);return true;
  },h);
}
