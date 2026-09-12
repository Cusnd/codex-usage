import {stableJson,validUploadBatch,type LegacyPreparation,type UploadBatch} from '../../../shared/sync-v3';
import {fail,sha256} from '../http';
import {advanceHead,currentDevice,domain,endGuard,guard,isCasFailure,type Domain,type WriteDevice} from './store';
import {advanceRebuild,rebuildCleanup,rebuildPublication,stageSourceStatements} from './rebuild';
import type {Job} from './jobs';

export function validLegacyPreparation(value:unknown):value is LegacyPreparation {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='collector_id,replacements')return false;
  const b=value as LegacyPreparation;
  return Array.isArray(b.replacements)&&b.replacements.length>0&&b.replacements.every(m=>m?.type==='legacy_replacement')&&b.replacements.reduce((n,m)=>n+(Array.isArray(m.sources)?m.sources.length:501),0)<=500&&
    validUploadBatch({protocol:3,schema_version:1,extractor_version:1,collector_id:b.collector_id,producer_epoch:'prepare',lane:'backfill',lane_seq:1,batch_id:'prepare',records_hash:'0'.repeat(64),sources:[],records:[],metadata:b.replacements});
}
/** No event equivalence is inferred: only the authenticated uploader's explicit source map stages facts. */
export async function prepareLegacySources(db:D1Database,device:WriteDevice,b:LegacyPreparation):Promise<boolean> {
  for(let attempt=0;attempt<3;attempt++)try{return await registerLegacySources(db,device,b);}catch(error){if(!isCasFailure(error))throw error;await currentDevice(db,device.user_id,device.id);}
  return fail(409,'WRITE_CONFLICT','迁移状态正在更新，请重试相同的来源映射。');
}
async function registerLegacySources(db:D1Database,device:WriteDevice,b:LegacyPreparation):Promise<boolean> {
  const h=await domain(db,device.user_id);
  if(h.mode!=='ready')return false;
  const owner=await db.prepare('SELECT device_id FROM v3_collectors WHERE user_id=? AND collector_id=?').bind(h.user_id,b.collector_id).first<string>('device_id');
  if(owner&&owner!==device.id)fail(409,'COLLECTOR_BOUND','采集身份已属于另一台设备。');
  const mappings:{source_id:string;generation:number;dataset_id:string;thread_id:string}[]=[];
  const pendingHeads=(await db.prepare(`SELECT DISTINCT h.dataset_id,h.thread_id FROM json_each(?) m
    CROSS JOIN usage_heads h LEFT JOIN v3_legacy_heads l USING(user_id,device_id,dataset_id,thread_id)
    WHERE h.user_id=? AND h.device_id=? AND h.dataset_id=json_extract(m.value,'$.dataset_id')
      AND h.thread_id=json_extract(m.value,'$.thread_id') AND h.revision>COALESCE(l.retired_revision,0)`)
    .bind(stableJson(b.replacements),h.user_id,device.id).all<{dataset_id:string;thread_id:string}>()).results;
  const pendingKeys=new Set(pendingHeads.map(h=>stableJson([h.dataset_id,h.thread_id])));
  for(const m of b.replacements){
    if(pendingKeys.has(stableJson([m.dataset_id,m.thread_id])))for(const s of m.sources)mappings.push({...s,dataset_id:m.dataset_id,thread_id:m.thread_id});
  }
  if(!mappings.length)return true;
  const active=(await db.prepare(`SELECT DISTINCT s.source_id,s.generation,s.context FROM v3_sources s JOIN json_each(?) m ON s.source_id=json_extract(m.value,'$.source_id') AND s.generation=json_extract(m.value,'$.generation') WHERE s.user_id=? AND s.collector_id=? AND s.active=1`).bind(stableJson(mappings),h.user_id,b.collector_id).all<{source_id:string;generation:number;context:string}>()).results;
  if(active.some(s=>mappings.some(m=>m.source_id===s.source_id&&m.generation===s.generation&&m.thread_id!==JSON.parse(s.context).thread_id)))fail(409,'LEGACY_SOURCE_MISMATCH','迁移来源与旧会话不匹配。');
  const op=crypto.randomUUID(),statements=[guard(db,h,op,device),db.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(h.user_id,b.collector_id,device.id,Date.now()),
    db.prepare('INSERT INTO v3_apply_guards(user_id,operation_id,ok) VALUES(?,?,EXISTS(SELECT 1 FROM v3_collectors WHERE user_id=? AND collector_id=? AND device_id=?))').bind(h.user_id,op+':collector',h.user_id,b.collector_id,device.id),
    db.prepare(`INSERT INTO v3_legacy_pending_sources(user_id,collector_id,source_id,generation,dataset_id,thread_id) SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.dataset_id'),json_extract(value,'$.thread_id') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(h.user_id,b.collector_id,stableJson(mappings))];
  if(active.length){
    // Older clients may already have published a partial replacement. Repair only this exact source set.
    const id='legacy-stage:'+await sha256(stableJson([device.id,b.collector_id,active.map(s=>[s.source_id,s.generation])])),payload={collector_id:b.collector_id,sources:active.map(({source_id,generation})=>({source_id,generation}))},checkpoint={phase:'events',epoch:crypto.randomUUID()};
    statements.push(...stageSourceStatements(db,h.user_id,id,active.map(s=>({collector_id:b.collector_id,source_id:s.source_id,generation:-1,payload:null}))),db.prepare(`INSERT INTO v3_jobs(user_id,job_id,kind,device_id,payload,checkpoint,created_at,updated_at) VALUES(?,?,'legacy_stage',?,?,?,?,?) ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',payload=excluded.payload,checkpoint=excluded.checkpoint,lease_token=NULL,lease_until=0,next_attempt_at=0,error_code=NULL`).bind(h.user_id,id,device.id,stableJson(payload),stableJson(checkpoint),Date.now(),Date.now()),db.prepare("UPDATE v3_sync_domains SET mode='rebuilding',rebuild_job=? WHERE user_id=?").bind(id,h.user_id));
  }
  statements.push(advanceHead(db,h,false),endGuard(db,h.user_id,op+':collector'),endGuard(db,h.user_id,op));await db.batch(statements);return !active.length&&!h.legacy_baseline_pending;
}
export async function pendingLegacySources(db:D1Database,h:Domain,device:WriteDevice,b:UploadBatch):Promise<Set<string>> {
  const rows=(await db.prepare(`SELECT DISTINCT p.source_id,p.generation,p.thread_id FROM v3_legacy_pending_sources p JOIN usage_heads h ON h.user_id=p.user_id AND h.device_id=? AND h.dataset_id=p.dataset_id AND h.thread_id=p.thread_id LEFT JOIN v3_legacy_heads l USING(user_id,device_id,dataset_id,thread_id) WHERE p.user_id=? AND p.collector_id=? AND h.revision>COALESCE(l.retired_revision,0) AND p.source_id IN(SELECT value FROM json_each(?))`).bind(device.id,h.user_id,b.collector_id,stableJson(b.sources.map(s=>s.source_id))).all<{source_id:string;generation:number;thread_id:string}>()).results;
  if(rows.some(r=>b.sources.some(s=>s.source_id===r.source_id&&s.generation===r.generation&&s.context.thread_id!==r.thread_id)))fail(409,'LEGACY_SOURCE_MISMATCH','迁移来源与旧会话不匹配。');
  return new Set(rows.map(s=>stableJson([s.source_id,s.generation])));
}
export async function legacyStageStep(db:D1Database,job:Job):Promise<boolean> {
  return advanceRebuild(db,job,async(h,c)=>{
    const p=JSON.parse(job.payload) as {collector_id:string;sources:{source_id:string;generation:number}[]},device=await currentDevice(db,h.user_id,job.device_id!),op=crypto.randomUUID();
    await db.batch([guard(db,h,op,device,job),...['v3_sources','v3_candidates'].map(t=>db.prepare(`UPDATE ${t} SET active=0 WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) s WHERE ${t}.source_id=json_extract(s.value,'$.source_id') AND ${t}.generation=json_extract(s.value,'$.generation'))`).bind(h.user_id,p.collector_id,stableJson(p.sources))),...rebuildPublication(db,h,job.job_id,c.epoch),advanceHead(db,h,false),db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),h.user_id,job.job_id),endGuard(db,h.user_id,op)]);return true;
  });
}
/** Pause/revoke/supersession discard the private repair; the durable source map remains for retry. */
export async function cancelLegacyStage(db:D1Database,job:Job) {
  const h=await domain(db,job.user_id),epoch=JSON.parse(job.checkpoint).epoch,op=crypto.randomUUID();
  await db.batch([guard(db,h,op,undefined,job),...['v3_events','v3_entity_versions','v3_aggregates','v3_aggregate_members'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=? AND epoch<>?`).bind(h.user_id,epoch,h.active_epoch)),...rebuildCleanup(db,h.user_id,job.job_id),db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(h.user_id,job.job_id),db.prepare("UPDATE v3_jobs SET state='cancelled',lease_token=NULL,lease_until=0 WHERE user_id=? AND job_id=?").bind(h.user_id,job.job_id),endGuard(db,h.user_id,op)]);
}
