import { stableJson, type UploadBatch } from '../../../shared/sync-v3';
import { consumeProjected, initialLegacyState } from '../../../shared/usage-domain/normalize';
import type { LegacyState, Observation, ThreadChange } from '../../../shared/usage-domain/types';
import { HttpError,sha256 } from '../http';
import { applyBatch, prepareMaterialization, type CandidateRow } from './apply';
import { decodeWire } from './codec';
import { advanceHead, chunks, domain, endGuard, entityStatements, guard, isCasFailure, type EntityMutation } from './store';
import { prepareProjectDeletion } from './projects';
import { rebuildCleanup,rebuildStep } from './rebuild';
import { measured,type SyncTiming } from './timing';
import { originFailureStatements,originStep,withdrawDeletedTarget } from './origins';
import {queryBudget,QueryBudgetExhausted} from './query-budget';

export type Job={user_id:string;job_id:string;kind:string;device_id:string|null;state:string;payload:string;checkpoint:string;lease_token:string;lease_until:number;attempts:number;next_attempt_at:number};
export async function claimJob(db:D1Database,user?:string,id?:string):Promise<Job|null> {
  const now=Date.now(),lease=crypto.randomUUID();
  return db.prepare(`UPDATE v3_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE rowid=(SELECT rowid FROM v3_jobs WHERE state IN('pending','running') AND next_attempt_at<=? AND lease_until<=? AND (? IS NULL OR user_id=?) AND (? IS NULL OR job_id=?) ORDER BY CASE WHEN kind='delete_device' THEN 0 WHEN job_id=(SELECT rebuild_job FROM v3_sync_domains h WHERE h.user_id=v3_jobs.user_id) THEN 1 ELSE 2 END,created_at,job_id LIMIT 1) RETURNING *`).bind(lease,now+30_000,now,now,now,user??null,user??null,id??null,id??null).first<Job>();
}
async function release(db:D1Database,job:Job,delay=1000,code:string|null=null) {
  await db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=?,error_code=?,updated_at=? WHERE user_id=? AND job_id=? AND lease_token=?").bind(Date.now()+delay,code,Date.now(),job.user_id,job.job_id,job.lease_token).run();
}
async function failJob(db:D1Database,job:Job,code:string,cancel=false) {
  const h=await domain(db,job.user_id),op=crypto.randomUUID();
  try{await db.batch([
    guard(db,h,op,undefined,job),
    db.prepare('UPDATE v3_jobs SET state=?,error_code=?,lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?').bind(cancel?'cancelled':'failed',code,Date.now(),job.user_id,job.job_id),
    ...['apply','rebuild'].includes(job.kind)?[
      db.prepare('UPDATE v3_receipts SET status=?,error_code=? WHERE user_id=? AND batch_id=?').bind(cancel?'cancelled':'failed',code,job.user_id,JSON.parse(job.payload).batch_id),
      db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(job.user_id,JSON.parse(job.payload).batch_id),
    ]:[],
    ...job.kind==='rebuild'?[
      ...['v3_events','v3_entity_versions','v3_aggregates','v3_aggregate_members'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=?`).bind(job.user_id,JSON.parse(job.checkpoint).epoch)),...rebuildCleanup(db,job.user_id,job.job_id),
      db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(job.user_id,job.job_id),
    ]:[],...job.kind==='origin_assignment'?originFailureStatements(db,h,job,code):[],endGuard(db,job.user_id,op),
  ]);}catch(error){if(!isCasFailure(error))throw error;}
}
async function restartRebuild(db:D1Database,job:Job,delay=30_000,code='DEVICE_PAUSED') {
  const h=await domain(db,job.user_id),epoch=JSON.parse(job.checkpoint).epoch,op=crypto.randomUUID();
  await db.batch([guard(db,h,op,undefined,job),...['v3_events','v3_entity_versions','v3_aggregates','v3_aggregate_members'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=? AND epoch<>?`).bind(job.user_id,epoch,h.active_epoch)),...rebuildCleanup(db,job.user_id,job.job_id),db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(job.user_id,job.job_id),db.prepare("UPDATE v3_jobs SET kind='apply',checkpoint='{}',state='pending',lease_token=NULL,lease_until=0,next_attempt_at=?,error_code=? WHERE user_id=? AND job_id=?").bind(Date.now()+delay,code,job.user_id,job.job_id),endGuard(db,job.user_id,op)]);
}
async function recoverSupersededRebuild(db:D1Database,job:Job) {
  const device=await db.prepare('SELECT revoked_at,history_deleted_at FROM devices WHERE user_id=? AND id=?').bind(job.user_id,job.device_id).first<{revoked_at:number|null;history_deleted_at:number|null}>();
  if(!device||device.revoked_at!==null||device.history_deleted_at!==null)return failJob(db,job,'DEVICE_REVOKED',true);
  // Another uploader's deletion supersedes this private epoch, not this received input.
  // Preserve its immutable wire and watermark; retry application against the post-delete head.
  return restartRebuild(db,job,0,'REBUILD_SUPERSEDED');
}

async function deleteDeviceStep(db:D1Database,job:Job):Promise<boolean> {
  const user=job.user_id,id=job.device_id!,h=await domain(db,user),device=await db.prepare('SELECT history_deleted_at FROM devices WHERE user_id=? AND id=?').bind(user,id).first<{history_deleted_at:number|null}>();
  if(!device||device.history_deleted_at===null)throw new HttpError(409,'DELETE_CANCELLED','删除状态已改变。');
  if(await withdrawDeletedTarget(db,h,job))return false;
  const candidates=(await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND uploader_device_id=? LIMIT 200').bind(user,id).all<CandidateRow>()).results;
  if(candidates.length){
    const changes=new Map<string,CandidateRow|null>(candidates.map(r=>[r.observation_id,null])),prepared=await prepareMaterialization(db,h,candidates,changes,[],true),op=crypto.randomUUID(),removed=prepared.changes.filter(c=>c.kind==='event'&&c.value===null).map(c=>c.id);
    const retained=[...changes.values()].filter((r):r is CandidateRow=>!!r);
    await db.batch([guard(db,h,op,undefined,job),db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(candidates.map(r=>r.observation_id))),...chunks(retained).map(group=>db.prepare(`UPDATE v3_candidates SET candidate=(SELECT json_extract(value,'$.candidate') FROM json_each(?) WHERE observation_id=json_extract(value,'$.observation_id')) WHERE user_id=? AND observation_id IN(SELECT json_extract(value,'$.observation_id') FROM json_each(?))`).bind(stableJson(group),user,stableJson(group))),...removed.length?[db.prepare('DELETE FROM v3_origin_operation_events WHERE user_id=? AND event_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(removed))]:[],...prepared.statements,...await entityStatements(db,h,prepared.changes),advanceHead(db,h,prepared.changes.length>0),db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),user,job.job_id),endGuard(db,user,op)]);
    return false;
  }
  // Metadata is also owned by the uploading collector. Keep metadata supplied by another device.
  const ownThreads=(await db.prepare('SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_collectors c USING(user_id,collector_id) WHERE t.user_id=? AND c.device_id=? LIMIT 100').bind(user,id).all<{thread_id:string}>()).results;
  if(ownThreads.length){const op=crypto.randomUUID(),changes:EntityMutation[]=[],statements:D1PreparedStatement[]=[];
    for(const {thread_id} of ownThreads){const old=await db.prepare('SELECT payload,revision FROM v3_threads WHERE user_id=? AND thread_id=?').bind(user,thread_id).first<{payload:string;revision:number}>();
      const remaining=(await db.prepare('SELECT t.payload FROM v3_source_threads t JOIN v3_collectors c USING(user_id,collector_id) JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND t.thread_id=? AND c.device_id<>? AND s.active=1 ORDER BY t.collector_id,t.source_id').bind(user,thread_id,id).all<{payload:string}>()).results;
      let value:ThreadChange|null=null;for(const row of remaining){const v=JSON.parse(row.payload) as ThreadChange;if(!value)value=v;else if(v.title!==undefined&&(v.title_updated_at||'')>(value.title_updated_at||''))value={...(value as ThreadChange),title:v.title,title_updated_at:v.title_updated_at};}
      if(stableJson(value)!==(old?.payload||'null')){changes.push({kind:'thread',id:thread_id,revision:(old?.revision||0)+1,value,thread_id});statements.push(value?db.prepare('INSERT INTO v3_threads(user_id,thread_id,payload,revision) VALUES(?,?,?,?) ON CONFLICT(user_id,thread_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision').bind(user,thread_id,stableJson(value),(old?.revision||0)+1):db.prepare('DELETE FROM v3_threads WHERE user_id=? AND thread_id=?').bind(user,thread_id));}}
    await db.batch([guard(db,h,op,undefined,job),db.prepare('DELETE FROM v3_source_threads WHERE user_id=? AND collector_id IN(SELECT collector_id FROM v3_collectors WHERE user_id=? AND device_id=?) AND thread_id IN(SELECT value FROM json_each(?))').bind(user,user,id,stableJson(ownThreads.map(r=>r.thread_id))),...statements,...await entityStatements(db,h,changes),advanceHead(db,h,changes.length>0),db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0 WHERE user_id=? AND job_id=?").bind(user,job.job_id),endGuard(db,user,op)]);return false;
  }
  const projects=await prepareProjectDeletion(db,h,id),op=crypto.randomUUID();
  await db.batch([guard(db,h,op,undefined,job),
    ...projects.statements,...await entityStatements(db,h,projects.changes),advanceHead(db,h,projects.changes.length>0),
    ...['v3_observations','v3_deferred_records','v3_dependencies'].map(table=>db.prepare(`DELETE FROM ${table} WHERE user_id=? AND collector_id IN(SELECT collector_id FROM v3_collectors WHERE user_id=? AND device_id=?)`).bind(user,user,id)),
    db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id IN(SELECT batch_id FROM v3_receipts WHERE user_id=? AND device_id=?)').bind(user,user,id),
    db.prepare("UPDATE v3_receipts SET status='cancelled',error_code='DEVICE_REVOKED' WHERE user_id=? AND device_id=? AND status='received'").bind(user,id),
    db.prepare("UPDATE v3_jobs SET state='cancelled',lease_token=NULL,lease_until=0 WHERE user_id=? AND device_id=? AND kind='apply' AND state IN('pending','running')").bind(user,id),
    db.prepare('DELETE FROM v3_collectors WHERE user_id=? AND device_id=?').bind(user,id),
    db.prepare('DELETE FROM cloud_accounts WHERE user_id=? AND device_id=?').bind(user,id),
    db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),user,job.job_id),
    db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN EXISTS(SELECT 1 FROM v3_jobs WHERE user_id=? AND kind='delete_device' AND state IN('pending','running') AND job_id<>?) THEN 'deleting' ELSE 'ready' END,write_version=write_version+1,updated_at=? WHERE user_id=?").bind(user,job.job_id,Date.now(),user),endGuard(db,user,op),
  ]);return true;
}

async function dependencyStep(db:D1Database,job:Job):Promise<boolean> {
  const h=await domain(db,job.user_id);if(h.mode!=='ready')return false;
  const p=JSON.parse(job.payload) as {collector_id:string;source_id:string;generation:number},args=[job.user_id,p.collector_id,p.source_id,p.generation];
  const source=await db.prepare('SELECT active,parser_state FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args).first<{active:number;parser_state:string|null}>();
  if(!source?.active){await failJob(db,job,'SOURCE_REPLACED',true);return true;}
  const parentRows=(await db.prepare('SELECT parent_thread_id,initial_state FROM v3_dependencies WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args).all<{parent_thread_id:string;initial_state:string|null}>()).results,parents=parentRows.map(r=>r.parent_thread_id);
  const complete=(await db.prepare('SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND s.active=1 AND s.complete=1 AND t.thread_id IN(SELECT value FROM json_each(?))').bind(job.user_id,stableJson(parents)).all<{thread_id:string}>()).results;
  if(parents.some(id=>!complete.some(r=>r.thread_id===id)))return false;
  const signatures=(await db.prepare('SELECT thread_id,at,signature FROM v3_candidates WHERE user_id=? AND active=1 AND thread_id IN(SELECT value FROM json_each(?)) AND signature IS NOT NULL').bind(job.user_id,stableJson(parents)).all<{thread_id:string;at:string;signature:string}>()).results;
  const parentHash=await sha256(stableJson(signatures.sort((a,b)=>stableJson(a).localeCompare(stableJson(b))))),checkpoint=JSON.parse(job.checkpoint) as {parent_hash?:string;last_locator?:number;state?:LegacyState},same=checkpoint.parent_hash===parentHash;
  const records=(await db.prepare('SELECT observation FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND source_id=? AND generation=? AND locator>? ORDER BY locator LIMIT 501').bind(...args,same?checkpoint.last_locator??-1:-1).all<{observation:string}>()).results.map(r=>JSON.parse(r.observation) as Observation),more=records.length>500;records.splice(500);
  if(!records.length){await db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0 WHERE user_id=? AND job_id=? AND lease_token=?").bind(job.user_id,job.job_id,job.lease_token).run();return true;}
  const prior=(await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(job.user_id,stableJson(records.map(r=>r.observation_id))).all<CandidateRow>()).results,owner=await db.prepare('SELECT device_id FROM v3_collectors WHERE user_id=? AND collector_id=?').bind(job.user_id,p.collector_id).first<string>('device_id');
  let state:LegacyState=same&&checkpoint.state?checkpoint.state:parentRows[0]?.initial_state?JSON.parse(parentRows[0].initial_state):initialLegacyState(records[0].context.thread_id);const mutations=new Map<string,CandidateRow|null>();
  for(const r of records){const parsed=consumeProjected(state,r,{parentStatus:()=> 'complete',parentHasSignature:(id,s,cut)=>signatures.some(v=>v.thread_id===id&&v.signature===s&&v.at<=cut)});state=parsed.state;mutations.set(r.observation_id,null);for(const c of parsed.candidates)mutations.set(r.observation_id,{observation_id:c.observation_id,uploader_device_id:owner!,collector_id:p.collector_id,source_id:p.source_id,generation:p.generation,record_revision:c.record_revision,event_id:c.event_id,thread_id:c.thread_id,turn_id:c.turn_id,at:c.at,signature:c.signature,active:1,candidate:stableJson(c)});}
  const prepared=await prepareMaterialization(db,h,prior,mutations),op=crypto.randomUUID(),statements:D1PreparedStatement[]=[guard(db,h,op,undefined,job)];
  for(const group of chunks([...mutations.values()].filter((c):c is CandidateRow=>!!c)))statements.push(db.prepare(`UPDATE v3_candidates SET candidate=(SELECT json_extract(value,'$.candidate') FROM json_each(?) WHERE observation_id=json_extract(value,'$.observation_id')) WHERE user_id=? AND observation_id IN(SELECT json_extract(value,'$.observation_id') FROM json_each(?))`).bind(stableJson(group),job.user_id,stableJson(group)));
  const removed=[...mutations].filter(([,c])=>!c).map(([id])=>id);if(removed.length)statements.push(db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(job.user_id,stableJson(removed)));
  statements.push(...prepared.statements,...await entityStatements(db,h,prepared.changes),advanceHead(db,h,prepared.changes.length>0));
  if(!more){const current:LegacyState=source.parser_state?JSON.parse(source.parser_state):state;statements.push(db.prepare('UPDATE v3_sources SET parser_state=? WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(stableJson({...current,inherited:current.inherited&&state.inherited,deferred:false}),...args),db.prepare('DELETE FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args),db.prepare('DELETE FROM v3_dependencies WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args));}
  statements.push(db.prepare('UPDATE v3_jobs SET state=?,checkpoint=?,lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?').bind(more?'pending':'complete',stableJson({parent_hash:parentHash,last_locator:records.at(-1)!.locator,state}),Date.now(),job.user_id,job.job_id),endGuard(db,job.user_id,op));
  await db.batch(statements);return !more;
}

export async function advanceJobs(db:D1Database,options:{user?:string;job_id?:string;maxSteps?:number;maxQueries?:number;budgetMs?:number;knownBatch?:UploadBatch;timing?:SyncTiming}={}) {
  // The largest existing failure/restart path uses 15 statements. Keep that recovery
  // capacity plus a final lease release inside, rather than outside, maxQueries.
  const budget=options.maxQueries===undefined?undefined:queryBudget(db,options.maxQueries,16),releaseDb=budget?.releaseDb??db,recoveryDb=budget?.recoveryDb??db;
  db=budget?.db??db;
  const deadline=Date.now()+(options.budgetMs??5000);let processed=0,budgetExhausted=false;
  while(processed<(options.maxSteps??4)&&Date.now()<deadline){let job:Job|null=null;
    try {
    job=await measured(options.timing,'job_claim',()=>claimJob(db,options.user,options.job_id));if(!job)break;processed++;
    try {
      let done:boolean;
      if(job.kind==='apply'){const id=JSON.parse(job.payload).batch_id,known=options.knownBatch;let b:UploadBatch;if(options.user===job.user_id&&known&&known.batch_id===id)b=known;else{const user=job.user_id,row=await measured(options.timing,'pending_read',()=>db.prepare('SELECT wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(user,id).first<{wire:ArrayBuffer}>());if(!row){await failJob(db,job,'MISSING_PENDING_INPUT');continue;}b=await decodeWire(new Uint8Array(row.wire));}done=await applyBatch(db,job.user_id,b,job,undefined,options.timing);}
      else if(job.kind==='delete_device')done=await deleteDeviceStep(db,job);
      else if(job.kind==='dependency')done=await dependencyStep(db,job);
      else if(job.kind==='rebuild')done=await rebuildStep(db,job);
      else if(job.kind==='origin_assignment')done=await originStep(db,job);
      else {await failJob(db,job,'UNKNOWN_JOB');continue;}
      if(!done)await release(db,job,job.kind==='dependency'?30_000:500);
    }catch(error){
      if(error instanceof QueryBudgetExhausted)throw error;
      if(error instanceof HttpError){if(error.code==='DEVICE_PAUSED'){if(job.kind==='rebuild')await restartRebuild(recoveryDb,job);else await release(releaseDb,job,30_000,error.code);}else if(error.code==='REBUILD_SUPERSEDED'&&job.kind==='rebuild')await recoverSupersededRebuild(recoveryDb,job);else await failJob(recoveryDb,job,error.code,error.code==='DEVICE_REVOKED');}
      else if(isCasFailure(error))await release(releaseDb,job,250,'WRITE_CONFLICT');
      else {await release(releaseDb,job,Math.min(60_000,1000*2**Math.min(job.attempts,6)),'APPLY_FAILED');throw error;}
    }
    }catch(error){
      if(!(error instanceof QueryBudgetExhausted))throw error;
      budgetExhausted=true;
      // Checkpoints already committed remain authoritative. The token guard makes this
      // a no-op if the successful checkpoint already released or replaced our lease.
      if(job)await release(releaseDb,job,0);
      break;
    }
  }
  return {steps:processed,queries:budget?.stats.queries??null,budgetExhausted};
}
