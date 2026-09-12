import { stableJson, type SyncCut } from "../../contracts/sync.js";
import type { CanonicalEvent } from "../../usage/types.js";
import { HttpError } from "../../platform/worker/http.js";
import { materializeCanonical } from "../apply/materialization.js";
import { type Job } from "./types.js";
import { metricStatements } from "../publication/metrics.js";
import { effectiveOrigin, withAssignment, type UserAssignment } from "../../organization/worker/origin-rules.js";
import { rebuildPublication, stagedEntities } from "../apply/rebuild.js";
import { advanceHead, chunks, cutOf, domain, endGuard, entityStatements, guard, type Domain, type EntityMutation } from "../publication/store.js";
import { type Operation, type Checkpoint, type Input, naturalUnknown, operation, assertTarget } from '../../organization/worker/origins.js';

const override=(o:Operation):UserAssignment|null=>o.action==='assign'?{operation_id:o.operation_id,device_id:o.device_id!,label:'用户指定'}:null;

function completeStatements(db:D1Database,h:Domain,job:Job,o:Operation,c:Checkpoint,cut:SyncCut){return [
  db.prepare("UPDATE v3_origin_operations SET status='complete',payload='{}',affected_events=?,result_cut=?,completed_at=? WHERE user_id=? AND operation_id=?").bind(c.selected,stableJson(cut),Date.now(),h.user_id,o.operation_id),
  db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),h.user_id,job.job_id),
];}

async function selectionStep(db:D1Database,h:Domain,o:Operation,c:Checkpoint):Promise<D1PreparedStatement[]>{
  const b=JSON.parse(o.payload) as Input,assignment=o.action==='assign'?"json_extract(v.payload,'$.user_assignment') IS NULL AND json_extract(e.payload,'$.user_assignment') IS NULL":"json_extract(v.payload,'$.user_assignment.operation_id') IS NOT NULL AND json_extract(v.payload,'$.user_assignment.operation_id')=json_extract(e.payload,'$.user_assignment.operation_id')";
  const rows=(await db.prepare(`SELECT e.event_id,json_extract(e.payload,'$.user_assignment.operation_id') previous_operation_id FROM v3_events e JOIN v3_entity_versions v ON v.user_id=e.user_id AND v.epoch=? AND v.kind='event' AND v.entity_id=e.event_id AND v.valid_from<=? AND (v.valid_to IS NULL OR v.valid_to>?) WHERE e.user_id=? AND e.epoch=? AND e.event_id>? AND e.thread_id IN(SELECT value FROM json_each(?)) AND v.payload IS NOT NULL AND ${naturalUnknown('v')} AND ${naturalUnknown('e')} AND ${assignment} ORDER BY e.event_id LIMIT 500`).bind(c.source_epoch,c.source_cut,c.source_cut,h.user_id,h.active_epoch,c.last||'',stableJson(b.thread_ids)).all<{event_id:string;previous_operation_id:string|null}>()).results;
  if(!rows.length){c.phase=c.selected<=200?'small':'events';delete c.last;return [];}
  c.last=rows.at(-1)!.event_id;c.selected+=rows.length;
  return chunks(rows).map(group=>db.prepare(`INSERT INTO v3_origin_operation_events(user_id,operation_id,operation_serial,event_id,previous_operation_id) SELECT ?,?,?,json_extract(value,'$.event_id'),json_extract(value,'$.previous_operation_id') FROM json_each(?)`).bind(h.user_id,o.operation_id,o.serial,stableJson(group)));
}

async function shadowEvents(db:D1Database,h:Domain,o:Operation,c:Checkpoint):Promise<D1PreparedStatement[]>{
  const rows=(await db.prepare(`SELECT e.event_id,e.revision,e.payload,r.event_id selected FROM v3_events e LEFT JOIN v3_origin_operation_events r ON r.user_id=e.user_id AND r.operation_id=? AND r.event_id=e.event_id WHERE e.user_id=? AND e.epoch=? AND e.event_id>? ORDER BY e.event_id LIMIT 300`).bind(o.operation_id,h.user_id,h.active_epoch,c.last||'').all<{event_id:string;revision:number;payload:string;selected:string|null}>()).results;
  if(!rows.length){c.phase='metadata';delete c.last;return [];}
  const changes:EntityMutation[]=rows.map(r=>{const before=JSON.parse(r.payload) as CanonicalEvent,value=r.selected?withAssignment(before,override(o))!:before;return {kind:'event',id:r.event_id,revision:r.revision+Number(stableJson(value)!==r.payload),value,at:value.at,thread_id:value.thread_id,origin_device_id:effectiveOrigin(value)};}),out=await stagedEntities(db,h,c.epoch,changes);
  for(const group of chunks(changes.map(v=>({revision:v.revision,...v.value as CanonicalEvent,origin_device_id:v.origin_device_id,payload:stableJson(v.value)}))))out.push(db.prepare(`INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,turn_id,origin_device_id,source_project_id,project,model,effort,payload) SELECT ?,?,json_extract(value,'$.event_id'),json_extract(value,'$.revision'),json_extract(value,'$.at'),json_extract(value,'$.thread_id'),json_extract(value,'$.turn_id'),json_extract(value,'$.origin_device_id'),json_extract(value,'$.source_project_id'),json_extract(value,'$.project'),json_extract(value,'$.model'),json_extract(value,'$.effort'),json_extract(value,'$.payload') FROM json_each(?)`).bind(h.user_id,c.epoch,stableJson(group)));
  out.push(...await metricStatements(db,{...h,active_epoch:c.epoch},changes.map(v=>({event_id:v.id,before:null,after:v.value as CanonicalEvent}))));c.last=rows.at(-1)!.event_id;return out;
}

async function shadowMetadata(db:D1Database,h:Domain,c:Checkpoint):Promise<D1PreparedStatement[]>{
  const rows=(await db.prepare("SELECT kind,entity_id FROM v3_entity_versions WHERE user_id=? AND epoch=? AND valid_to IS NULL AND payload IS NOT NULL AND kind<>'event' AND (kind||':'||entity_id)>? ORDER BY kind||':'||entity_id LIMIT 300").bind(h.user_id,h.active_epoch,c.last||'').all<{kind:string;entity_id:string}>()).results;
  if(!rows.length){c.phase='publish';delete c.last;return [];}
  c.last=rows.at(-1)!.kind+':'+rows.at(-1)!.entity_id;
  return [db.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,at,thread_id,origin_device_id,payload) SELECT v.user_id,?,v.kind,v.entity_id,0,v.revision,v.hash,v.at,v.thread_id,v.origin_device_id,v.payload FROM json_each(?) j CROSS JOIN v3_entity_versions v WHERE v.user_id=? AND v.epoch=? AND v.kind=json_extract(j.value,'$.kind') AND v.entity_id=json_extract(j.value,'$.entity_id') AND v.valid_to IS NULL AND v.payload IS NOT NULL`).bind(c.epoch,stableJson(rows),h.user_id,h.active_epoch)];
}

export async function originStep(db:D1Database,job:Job):Promise<boolean>{
  const h=await domain(db,job.user_id),o=await operation(db,job.user_id,JSON.parse(job.payload).operation_id),c=JSON.parse(job.checkpoint) as Checkpoint;
  if(h.mode!=='rebuilding'||h.rebuild_job!==job.job_id)throw new HttpError(409,'REBUILD_SUPERSEDED','归属修改已被删除操作替代。');
  if(o.action==='assign')await assertTarget(db,h.user_id,o.device_id!);
  const op=crypto.randomUUID();let statements:D1PreparedStatement[];
  if(c.phase==='small'){
    const rows=(await db.prepare('SELECT e.event_id,e.payload FROM v3_origin_operation_events r CROSS JOIN v3_events e WHERE r.user_id=? AND r.operation_id=? AND e.user_id=r.user_id AND e.epoch=? AND e.event_id=r.event_id').bind(h.user_id,o.operation_id,h.active_epoch).all<{event_id:string;payload:string}>()).results,values=new Map(rows.map(r=>[r.event_id,JSON.parse(r.payload) as CanonicalEvent])),prepared=await materializeCanonical(db,h,values,new Map(rows.map(r=>[r.event_id,override(o)])));
    c.selected=prepared.changes.length;const cut={...cutOf(h),commit_seq:h.commit_seq+Number(!!prepared.changes.length)};
    await db.batch([guard(db,h,op,undefined,job),...prepared.statements,...await entityStatements(db,h,prepared.changes),advanceHead(db,h,!!prepared.changes.length),...completeStatements(db,h,job,o,c,cut),db.prepare("UPDATE v3_sync_domains SET mode='ready',rebuild_job=NULL WHERE user_id=? AND rebuild_job=?").bind(h.user_id,job.job_id),endGuard(db,h.user_id,op)]);return true;
  }
  if(c.phase==='publish'){
    const cut={...cutOf(h),dataset_epoch:c.epoch,commit_seq:0};
    await db.batch([guard(db,h,op,undefined,job),...rebuildPublication(db,h,job.job_id,c.epoch),advanceHead(db,h,false),...completeStatements(db,h,job,o,c,cut),endGuard(db,h.user_id,op)]);return true;
  }
  statements=c.phase==='select'?await selectionStep(db,h,o,c):c.phase==='events'?await shadowEvents(db,h,o,c):await shadowMetadata(db,h,c);
  await db.batch([guard(db,h,op,undefined,job),...statements,db.prepare("UPDATE v3_jobs SET checkpoint=?,state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(stableJson(c),Date.now(),h.user_id,job.job_id),endGuard(db,h.user_id,op)]);return false;
}

export function originFailureStatements(db:D1Database,h:Domain,job:Job,code:string):D1PreparedStatement[]{const c=JSON.parse(job.checkpoint) as Checkpoint;return [
  ...['v3_events','v3_entity_versions','v3_aggregates','v3_aggregate_members'].map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=? AND epoch<>?`).bind(h.user_id,c.epoch,h.active_epoch)),
  db.prepare('DELETE FROM v3_origin_operation_events WHERE user_id=? AND operation_id=?').bind(h.user_id,JSON.parse(job.payload).operation_id),
  db.prepare("UPDATE v3_origin_operations SET status='failed',payload='{}',error_code=?,completed_at=? WHERE user_id=? AND operation_id=? AND status='pending'").bind(code,Date.now(),h.user_id,JSON.parse(job.payload).operation_id),
  db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(h.user_id,job.job_id),
];}

/** History deletion follows uploader ownership; a deleted assignment target only withdraws its labels. */
export async function withdrawDeletedTarget(db:D1Database,h:Domain,job:Job):Promise<boolean>{
  const rows=(await db.prepare("SELECT event_id,payload FROM v3_events WHERE user_id=? AND epoch=? AND origin_device_id=? AND json_extract(payload,'$.user_assignment.device_id')=? LIMIT 200").bind(h.user_id,h.active_epoch,job.device_id,job.device_id).all<{event_id:string;payload:string}>()).results;if(!rows.length)return false;
  const prepared=await materializeCanonical(db,h,new Map(rows.map(r=>[r.event_id,JSON.parse(r.payload) as CanonicalEvent]))),op=crypto.randomUUID();
  await db.batch([guard(db,h,op,undefined,job),...prepared.statements,...await entityStatements(db,h,prepared.changes),advanceHead(db,h,!!prepared.changes.length),db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0 WHERE user_id=? AND job_id=?").bind(h.user_id,job.job_id),endGuard(db,h.user_id,op)]);return true;
}
