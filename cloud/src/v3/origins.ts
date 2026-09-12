import { stableJson,type SyncCut } from '../../../shared/sync-v3';
import type { CanonicalEvent } from '../../../shared/usage-domain/types';
import { fail,HttpError,json,readJson,requireJson,requireSameOrigin,sha256 } from '../http';
import { materializeCanonical } from './apply';
import { advanceJobs,type Job } from './jobs';
import { metricStatements } from './metrics';
import { effectiveOrigin,withAssignment,type UserAssignment } from './origin-rules';
import { rebuildPublication,stagedEntities } from './rebuild';
import { createRead,getRead } from './snapshots';
import { advanceHead,chunks,cutOf,domain,endGuard,entityStatements,guard,isCasFailure,type Domain,type EntityMutation } from './store';

type Input={operation_id:string;lease_id:string;action:'assign'|'revoke';thread_ids:string[];device_id?:string};
type Operation={serial:number;operation_id:string;request_hash:string;action:'assign'|'revoke';device_id:string|null;status:'pending'|'complete'|'failed';payload:string;affected_events:number;result_cut:string|null;error_code:string|null};
type Checkpoint={phase:'select'|'small'|'events'|'metadata'|'publish';epoch:string;source_epoch:string;source_cut:number;last?:string;selected:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const naturalUnknown=(alias:string)=>`json_extract(${alias}.payload,'$.origin_device_id') IS NULL AND COALESCE(json_extract(${alias}.payload,'$.origin_conflict'),0)=0`;
const counts=`SUM(CASE WHEN json_extract(v.payload,'$.origin_device_id') IS NULL AND COALESCE(json_extract(v.payload,'$.origin_conflict'),0)=0 AND json_extract(v.payload,'$.user_assignment') IS NULL THEN 1 ELSE 0 END) unknown_events,SUM(CASE WHEN json_extract(v.payload,'$.user_assignment') IS NOT NULL THEN 1 ELSE 0 END) assigned_events,SUM(CASE WHEN json_extract(v.payload,'$.origin_device_id') IS NOT NULL THEN 1 ELSE 0 END) natural_known_events`;
const versionScope=`WITH versions AS(SELECT v.* FROM v3_entity_versions v WHERE v.user_id=? AND v.epoch=? AND v.valid_from<=? AND (v.valid_to IS NULL OR v.valid_to>?) AND v.payload IS NOT NULL)`;
async function operation(db:D1Database,user:string,id:string):Promise<Operation>{return (await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user,id).first<Operation>())??fail(404,'NOT_FOUND','归属操作不存在。');}
const result=(o:Operation)=>({operation_id:o.operation_id,status:o.status,job_id:'origin:'+o.operation_id,...o.status==='complete'?{affected_events:o.affected_events,cut:JSON.parse(o.result_cut!)}:{},...o.status==='failed'?{error:{code:o.error_code,message:'归属修改未完成，原有已发布历史保持可用，请重新读取后重试。'}}:{}});
async function assertTarget(db:D1Database,user:string,id:string){if(!await db.prepare('SELECT id FROM devices WHERE user_id=? AND id=? AND history_deleted_at IS NULL').bind(user,id).first())fail(404,'NOT_FOUND','指定设备不存在或其历史已删除。');}

export async function originView(db:D1Database,user:string,url:URL){
  const id=url.searchParams.get('lease_id')||(await createRead(db,user,'full',[])).lease_id,lease=await getRead(db,user,id),limit=Number(url.searchParams.get('limit')||50),cursor=url.searchParams.get('cursor')||'';
  if(lease.scope!=='full'||JSON.parse(lease.device_ids).length)fail(400,'INVALID_SCOPE','归属管理需要全部设备的完整读取版本。');
  if(!Number.isInteger(limit)||limit<1||limit>200||cursor.length>2048)fail(400,'INVALID_CURSOR','分页参数无效。');
  const args=[user,lease.epoch,lease.cut,lease.cut],summary=await db.prepare(versionScope+` SELECT ${counts} FROM versions v WHERE v.kind='event'`).bind(...args).first<Record<string,number|null>>();
  const rows=(await db.prepare(versionScope+` SELECT v.thread_id id,(SELECT json_extract(t.payload,'$.title') FROM versions t WHERE t.kind='thread' AND t.entity_id=v.thread_id) title,${counts} FROM versions v WHERE v.kind='event' AND v.thread_id>? GROUP BY v.thread_id HAVING unknown_events+assigned_events>0 ORDER BY v.thread_id LIMIT ?`).bind(...args,cursor,limit+1).all()).results;
  await getRead(db,user,id);
  return {lease_id:id,cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version},summary:Object.fromEntries(Object.entries(summary!).map(([k,v])=>[k,v??0])),sessions:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].id:null};
}
async function start(db:D1Database,user:string,b:Input){
  if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['operation_id','lease_id','action','thread_ids','device_id'].includes(k))||!uuid.test(b.operation_id)||typeof b.lease_id!=='string'||b.lease_id.length>256||!['assign','revoke'].includes(b.action)||!Array.isArray(b.thread_ids)||!b.thread_ids.length||b.thread_ids.length>200||b.thread_ids.some(id=>typeof id!=='string'||!id||id.length>2048)||new Set(b.thread_ids).size!==b.thread_ids.length||b.action==='assign'&&(typeof b.device_id!=='string'||!b.device_id||b.device_id.length>256)||b.action==='revoke'&&b.device_id!==undefined)fail(400,'INVALID_INPUT','归属操作参数无效。');
  b={...b,thread_ids:[...b.thread_ids].sort()};const hash=await sha256(stableJson(b)),saved=await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user,b.operation_id).first<Operation>();
  if(saved){if(saved.request_hash!==hash)fail(409,'OPERATION_CONFLICT','同一操作编号已经对应其他内容。');return saved;}
  const lease=await getRead(db,user,b.lease_id);if(lease.scope!=='full'||JSON.parse(lease.device_ids).length)fail(400,'INVALID_SCOPE','归属管理需要全部设备的完整读取版本。');
  if(b.action==='assign')await assertTarget(db,user,b.device_id!);
  const h=await domain(db,user);if(h.mode!=='ready')fail(409,'DATASET_UPDATING','历史正在更新，请稍后重试。');
  const job='origin:'+b.operation_id,op=crypto.randomUUID(),now=Date.now(),checkpoint:Checkpoint={phase:'select',epoch:crypto.randomUUID(),source_epoch:lease.epoch,source_cut:lease.cut,selected:0};
  try{await db.batch([guard(db,h,op),
    db.prepare('INSERT INTO v3_origin_operations(user_id,operation_id,request_hash,action,device_id,payload,created_at) VALUES(?,?,?,?,?,?,?)').bind(user,b.operation_id,hash,b.action,b.device_id??null,stableJson(b),now),
    db.prepare("INSERT INTO v3_jobs(user_id,job_id,kind,payload,checkpoint,created_at,updated_at) VALUES(?,?,'origin_assignment',?,?,?,?)").bind(user,job,stableJson({operation_id:b.operation_id}),stableJson(checkpoint),now,now),
    db.prepare("UPDATE v3_sync_domains SET mode='rebuilding',rebuild_job=?,write_version=write_version+1 WHERE user_id=?").bind(job,user),endGuard(db,user,op)]);
  }catch(error){const existing=await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user,b.operation_id).first<Operation>();if(existing&&existing.request_hash===hash)return existing;if(isCasFailure(error))fail(409,'WRITE_CONFLICT','历史版本正在变化，请重试同一操作。');throw error;}
  return operation(db,user,b.operation_id);
}
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
export async function originRoute(request:Request,env:Env,path:string,user:string):Promise<Response|null>{
  if(path==='/api/v3/origins'&&request.method==='GET')return json(await originView(env.DB,user,new URL(request.url)));
  if(path==='/api/v3/origins/operations'&&request.method==='POST'){
    requireSameOrigin(request,env);requireJson(request);const o=await start(env.DB,user,await readJson(request,65536) as Input);if(o.status==='pending')await advanceJobs(env.DB,{user,job_id:'origin:'+o.operation_id,maxSteps:4,budgetMs:4000});const saved=await operation(env.DB,user,o.operation_id);return json(result(saved),saved.status==='complete'?200:202);
  }
  const match=/^\/api\/v3\/origins\/operations\/([^/]+)$/.exec(path);if(match&&request.method==='GET'){const id=decodeURIComponent(match[1]);await operation(env.DB,user,id);await advanceJobs(env.DB,{user,job_id:'origin:'+id,maxSteps:4,budgetMs:4000});return json(result(await operation(env.DB,user,id)));}
  return null;
}
