import { d1PublicationStore } from "../publication/commit.js";
import { stableJson, type UploadBatch } from "../../contracts/sync.js";
import type { ThreadChange } from "../../usage/types.js";
import { assertWritableDevice, chunks, entityStatements, isCasFailure, progressStatements, type Domain, type JobLease, type Receipt, type WriteDevice } from "../publication/store.js";
import { prepareProjectMetadata } from "../../organization/worker/projects.js";
import { rebuildPublication, startReplacement } from "./rebuild.js";
import { measured, type SyncTiming } from "../../foundation/timing.js";
import { prepareMaterialization } from "./materialization.js";
import type { CandidateRow } from "../../usage/candidate-row.js";
import { type SourceRow, type SavedObservation, planSources } from './plan-sources.js';
import { dependencies } from './dependencies.js';

export async function applyBatch(db:D1Database,user:string,b:UploadBatch,job?:JobLease,publishEpoch?:string,timing?:SyncTiming):Promise<boolean> {
  for(let attempt=0;attempt<3;attempt++){
    timing?.count('apply_attempts');
    const loaded=await measured(timing,'apply_load',()=>db.batch([
      db.prepare('SELECT * FROM v3_receipts WHERE user_id=? AND batch_id=?').bind(user,b.batch_id),
      db.prepare('SELECT * FROM v3_sync_domains WHERE user_id=?').bind(user),
      db.prepare('SELECT d.* FROM devices d JOIN v3_receipts r ON r.user_id=d.user_id AND r.device_id=d.id WHERE r.user_id=? AND r.batch_id=?').bind(user,b.batch_id),
      db.prepare('SELECT applied_seq FROM v3_producer_progress WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=?').bind(user,b.collector_id,b.producer_epoch,b.lane),
      db.prepare('SELECT * FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson(b.sources.map(s=>s.source_id))),
      db.prepare('SELECT * FROM v3_observations WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(b.records.map(r=>r.observation_id))),
      db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(b.records.map(r=>r.observation_id))),
      ...b.records.some(r=>r.origin.kind==='preserved'&&r.origin.device_id)?[db.prepare('SELECT id FROM devices WHERE user_id=? AND id IN(SELECT value FROM json_each(?))').bind(user,stableJson([...new Set(b.records.filter(r=>r.origin.kind==='preserved').map(r=>r.origin.device_id))]))]:[],
    ]));
    const saved=loaded[0].results[0] as Receipt|undefined;if(!saved)throw Error('missing receipt');if(saved.status==='applied')return true;if(saved.status!=='received')return false;
    const device=assertWritableDevice(loaded[2].results[0] as WriteDevice|null),h=loaded[1].results[0] as Domain|undefined;if(!h)return false;if(publishEpoch?(h.mode!=='rebuilding'||h.rebuild_job!==job?.job_id):(h.mode!=='ready'))return false;
    const publication=publishEpoch?{...h,active_epoch:publishEpoch,commit_seq:0}:h;
    const progress=(loaded[3].results[0] as {applied_seq:number}|undefined)?.applied_seq;
    if(b.lane_seq!==(progress||0)+1)return false;
    const sources=loaded[4].results as SourceRow[],priorObservations=loaded[5].results as SavedObservation[],inputOld=loaded[6].results as CandidateRow[];
    const observationsById=new Map(priorObservations.map(r=>[r.observation_id,r])),ownedDevices=new Set((loaded[7]?.results as {id:string}[]|undefined)?.map(r=>r.id));
    const plan=await planSources({user,b,device,sources,observationsById,ownedDevices},await dependencies(db,user,b.records));
    if(!plan)return false;
    const {candidateMutations,sourceUpdates,observationUpdates,threadWrites,deferred,resolvedIds,dependencyRows,replacements}=plan;
    if(!publishEpoch&&replacements.length){const n=await db.prepare('SELECT COUNT(*) n FROM v3_candidates WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson(replacements.map(r=>r.source_id))).first<number>('n');if((n||0)>500){await startReplacement(db,h,device,b,job,sourceUpdates,candidateMutations,threadWrites);return false;}}
    const initial=[...inputOld];
    if(!publishEpoch&&replacements.length){const replaced=new Map(replacements.map(s=>[s.source_id,s])),related=await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson([...replaced.keys()])).all<CandidateRow>();for(const r of related.results){const old=replaced.get(r.source_id)!;initial.push(r);if(r.generation===old.generation)candidateMutations.set(r.observation_id,{...r,active:0});else if(r.generation===sourceUpdates.find(s=>s.source_id===old.source_id)!.generation&&!candidateMutations.has(r.observation_id))candidateMutations.set(r.observation_id,{...r,active:1});}}
    // A replacement's final packet may contain no metadata; promote the metadata staged earlier too.
    const replacedSources=replacements.map(old=>({source_id:old.source_id,generation:sourceUpdates.find(s=>s.source_id===old.source_id)!.generation}));
    if(!publishEpoch&&replacedSources.length){const staged=(await db.prepare(`SELECT t.source_id,t.generation,t.thread_id,t.payload FROM json_each(?) j JOIN v3_source_threads t ON t.source_id=json_extract(j.value,'$.source_id') AND t.generation=json_extract(j.value,'$.generation') WHERE t.user_id=? AND t.collector_id=?`).bind(stableJson(replacedSources),user,b.collector_id).all<{source_id:string;generation:number;thread_id:string;payload:string}>()).results;for(const t of staged)if(!threadWrites.some(w=>w.source_id===t.source_id&&w.generation===t.generation&&w.thread_id===t.thread_id))threadWrites.push(t);}
    const materialized=publishEpoch?{statements:[],changes:[]}:await measured(timing,'canonical',()=>prepareMaterialization(db,h,initial,candidateMutations));
    const projects=await measured(timing,'projects',()=>prepareProjectMetadata(db,h,b,device.id)),changes=[...materialized.changes,...projects.changes],threadStatements:D1PreparedStatement[]=[];
    const updatedThreads:{id:string;payload:string;revision:number}[]=[],threadIds=[...new Set(threadWrites.map(t=>t.thread_id))],oldThreads=new Map<string,{payload:string;revision:number}>();
    if(!publishEpoch)for(const group of chunks(threadIds)){const rows=await db.prepare('SELECT thread_id,payload,revision FROM v3_threads WHERE user_id=? AND thread_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(group)).all<{thread_id:string;payload:string;revision:number}>();for(const row of rows.results)oldThreads.set(row.thread_id,row);}
    if(!publishEpoch)for(const id of threadIds){
      const old=oldThreads.get(id);
      let value:ThreadChange|undefined=old?JSON.parse(old.payload):undefined;
      for(const row of threadWrites.filter(t=>t.thread_id===id)){const source=sourceUpdates.find(s=>s.source_id===row.source_id&&s.generation===row.generation);if(!source?.active)continue;const update=JSON.parse(row.payload) as ThreadChange;
        if(update.title!==undefined){if(!value)value=update;else if((update.title_updated_at||'')>=(value.title_updated_at||''))value={...value,title:update.title,title_updated_at:update.title_updated_at};}else value={...value,...update};}
      if(value&&stableJson(value)!==old?.payload){const revision=(old?.revision||0)+1,payload=stableJson(value);updatedThreads.push({id,payload,revision});changes.push({kind:'thread',id,revision,value,thread_id:id});}
    }
    for(const group of chunks(updatedThreads))threadStatements.push(db.prepare(`INSERT INTO v3_threads(user_id,thread_id,payload,revision) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.payload'),json_extract(value,'$.revision') FROM json_each(?) WHERE true ON CONFLICT(user_id,thread_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision`).bind(user,stableJson(group)));
    const op=crypto.randomUUID(),statements:D1PreparedStatement[]=[];
    if(publishEpoch&&sourceUpdates.length){const updates=stableJson(sourceUpdates.map(s=>({source_id:s.source_id,generation:s.generation,active:s.active})));statements.push(db.prepare(`UPDATE v3_candidates SET active=(SELECT json_extract(value,'$.active') FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation')) WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation'))`).bind(updates,user,b.collector_id,updates));}
    const availability=new Map<string,number>();for(const m of b.metadata)if(m.type==='source_availability')availability.set(m.source_id,Number(m.available));
    if(availability.size){const updates=stableJson([...availability].map(([source_id,available])=>({source_id,available})));statements.push(db.prepare(`UPDATE v3_sources SET available=(SELECT json_extract(value,'$.available') FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id')) WHERE user_id=? AND collector_id=? AND source_id IN(SELECT json_extract(value,'$.source_id') FROM json_each(?))`).bind(updates,user,b.collector_id,updates));}
    if(replacements.length)statements.push(db.prepare('UPDATE v3_sources SET active=0 WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?)) AND active=1').bind(user,b.collector_id,stableJson(replacements.map(s=>s.source_id))));
    for(const group of chunks(sourceUpdates))statements.push(db.prepare(`INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,cursor,snapshot_eof,context_hash,context,parser_state,active,complete,available,trailing_bytes)
      SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.kind'),json_extract(value,'$.cursor'),json_extract(value,'$.snapshot_eof'),json_extract(value,'$.context_hash'),json_extract(value,'$.context'),json_extract(value,'$.parser_state'),json_extract(value,'$.active'),json_extract(value,'$.complete'),json_extract(value,'$.available'),json_extract(value,'$.trailing_bytes') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,collector_id,source_id,generation) DO UPDATE SET cursor=excluded.cursor,snapshot_eof=excluded.snapshot_eof,context_hash=excluded.context_hash,context=excluded.context,parser_state=excluded.parser_state,active=excluded.active,complete=excluded.complete,available=excluded.available,trailing_bytes=excluded.trailing_bytes`).bind(user,b.collector_id,stableJson(group)));
    const removed=[...candidateMutations].filter(([,r])=>!r).map(([id])=>id);if(removed.length)statements.push(db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(removed)));
    for(const group of chunks([...candidateMutations.values()].filter((r):r is CandidateRow=>!!r)))statements.push(db.prepare(`INSERT INTO v3_candidates(user_id,observation_id,uploader_device_id,collector_id,source_id,generation,record_revision,event_id,thread_id,turn_id,at,signature,active,candidate,origin_claim)
      SELECT ?,json_extract(value,'$.observation_id'),json_extract(value,'$.uploader_device_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.record_revision'),json_extract(value,'$.event_id'),json_extract(value,'$.thread_id'),json_extract(value,'$.turn_id'),json_extract(value,'$.at'),json_extract(value,'$.signature'),json_extract(value,'$.active'),json_extract(value,'$.candidate'),json_extract(value,'$.origin_claim') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,observation_id) DO UPDATE SET record_revision=excluded.record_revision,event_id=excluded.event_id,thread_id=excluded.thread_id,turn_id=excluded.turn_id,at=excluded.at,signature=excluded.signature,active=excluded.active,candidate=excluded.candidate,origin_claim=excluded.origin_claim`).bind(user,stableJson(group)));
    for(const group of chunks(observationUpdates))statements.push(db.prepare(`INSERT INTO v3_observations(user_id,observation_id,collector_id,source_id,generation,record_revision,content_hash) SELECT ?,json_extract(value,'$.observation_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.record_revision'),json_extract(value,'$.content_hash') FROM json_each(?) WHERE true ON CONFLICT(user_id,observation_id) DO UPDATE SET record_revision=excluded.record_revision,content_hash=excluded.content_hash`).bind(user,stableJson(group)));
    for(const group of chunks(threadWrites))statements.push(db.prepare(`INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.thread_id'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT(user_id,collector_id,source_id,generation,thread_id) DO UPDATE SET payload=excluded.payload`).bind(user,b.collector_id,stableJson(group)));
    for(const group of chunks(deferred))statements.push(db.prepare(`INSERT INTO v3_deferred_records(user_id,observation_id,collector_id,source_id,generation,locator,observation) SELECT ?,json_extract(value,'$.observation_id'),?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.locator'),json_extract(value,'$.observation') FROM json_each(?) WHERE true ON CONFLICT(user_id,observation_id) DO UPDATE SET observation=excluded.observation`).bind(user,b.collector_id,stableJson(group)));
    for(const group of chunks(dependencyRows))statements.push(db.prepare(`INSERT INTO v3_dependencies(user_id,collector_id,source_id,generation,parent_thread_id,initial_state) SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.parent_thread_id'),json_extract(value,'$.initial_state') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(user,b.collector_id,stableJson(group)));
    if(resolvedIds.length)statements.push(db.prepare('DELETE FROM v3_deferred_records WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(resolvedIds)));
    const resolvedSources=sourceUpdates.filter(s=>!JSON.parse(s.parser_state!).deferred).map(s=>({source_id:s.source_id,generation:s.generation}));
    if(resolvedSources.length)statements.push(db.prepare(`DELETE FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation'))`).bind(user,b.collector_id,stableJson(resolvedSources)));
    const completedParents=[...new Set(b.sources.filter(s=>s.generation_complete).map(s=>s.context.thread_id))];
    if(completedParents.length)statements.push(db.prepare(`INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
      SELECT d.user_id,'dependency:'||d.collector_id||':'||d.source_id||':'||d.generation,'dependency',json_object('collector_id',d.collector_id,'source_id',d.source_id,'generation',d.generation),?,? FROM v3_dependencies d WHERE d.user_id=? AND d.parent_thread_id IN(SELECT value FROM json_each(?))
      ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0 WHERE v3_jobs.state<>'running'`).bind(Date.now(),Date.now(),user,stableJson(completedParents)));
    // Superseded generations are no longer current facts or pending replay inputs.
    if(replacedSources.length)for(const table of ['v3_candidates','v3_observations','v3_source_threads','v3_deferred_records','v3_dependencies','v3_sources'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation<json_extract(value,'$.generation'))`).bind(user,b.collector_id,stableJson(replacedSources)));
    statements.push(...materialized.statements,...threadStatements,...projects.statements,...await entityStatements(db,publication,changes),
      ...publishEpoch?rebuildPublication(db,h,'apply:'+b.batch_id,publishEpoch):[],
      db.prepare("UPDATE v3_receipts SET status='applied',applied_epoch=?,applied_commit_seq=?,applied_at=? WHERE user_id=? AND batch_id=?").bind(publication.active_epoch,publication.commit_seq+Number(changes.length>0),Date.now(),user,b.batch_id),
      db.prepare('UPDATE devices SET protocol=3 WHERE user_id=? AND id=?').bind(user,device.id),
      db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(user,b.batch_id),
      db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),user,'apply:'+b.batch_id),
      ...progressStatements(db,b,user));
    try{await measured(timing,'apply_commit',()=>d1PublicationStore(db).commit({head:h,operationId:op,device,job,hasChanges:changes.length>0,effects:statements}));return true;}catch(error){if(isCasFailure(error)){timing?.count('cas_retries');continue;}throw error;}
  }
  return false;
}

export { prepareMaterialization, materializeCanonical } from './materialization.js';

export { canonicalFromRows } from './canonical.js';

export type { CandidateRow } from '../../usage/candidate-row.js';
