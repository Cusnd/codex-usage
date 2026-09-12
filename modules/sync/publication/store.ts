import type { UploadAck, UploadBatch, SyncCut, EntityKind } from "../../contracts/sync.js";
import { stableJson } from "../../contracts/sync.js";
import { fail, sha256 } from "../../platform/worker/http.js";
import { chunks } from '../../foundation/chunks.js';

export type Domain = {
  user_id:string; active_epoch:string; write_version:number; commit_seq:number;
  organization_version:number; deletion_version:number; config_version:number;
  mode:'ready'|'rebuilding'|'deleting'; changes_floor:number; updated_at:number;
  rebuild_job:string|null;
};

export type WriteDevice = {id:string;user_id:string;token_hash:string;auth_version:number;paused:number;revoked_at:number|null;history_deleted_at:number|null};

export type Receipt = {
  user_id:string;batch_id:string;device_id:string;collector_id:string;producer_epoch:string;
  lane:string;lane_seq:number;wire_hash:string;records_hash:string;
  status:'received'|'applied'|'cancelled'|'failed';received_at:number;
  applied_epoch:string|null;applied_commit_seq:number|null;error_code:string|null;
};

export type EntityMutation = {kind:EntityKind;id:string;revision:number;value:unknown|null;at?:string|null;thread_id?:string|null;origin_device_id?:string|null};

export type JobLease = {job_id:string;lease_token:string};

export const cutOf=(h:Domain):SyncCut=>({dataset_epoch:h.active_epoch,commit_seq:h.commit_seq,deletion_version:h.deletion_version,organization_version:h.organization_version,config_version:h.config_version});

export async function domain(db:D1Database,user:string):Promise<Domain> {
  const existing=await db.prepare('SELECT * FROM v3_sync_domains WHERE user_id=?').bind(user).first<Domain>();if(existing)return existing;
  await db.prepare('INSERT INTO v3_sync_domains(user_id,active_epoch,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING').bind(user,crypto.randomUUID(),Date.now()).run();
  return (await db.prepare('SELECT * FROM v3_sync_domains WHERE user_id=?').bind(user).first<Domain>())!;
}

export function assertWritableDevice(row:WriteDevice|null):WriteDevice {
  if(!row||row.revoked_at!==null||row.history_deleted_at!==null)return fail(401,'DEVICE_REVOKED','设备上传身份已撤销。');
  if(row.paused)return fail(423,'DEVICE_PAUSED','设备同步已暂停。');return row;
}

export async function currentDevice(db:D1Database,user:string,id:string):Promise<WriteDevice> {
  const row=await db.prepare('SELECT id,user_id,token_hash,auth_version,paused,revoked_at,history_deleted_at FROM devices WHERE user_id=? AND id=?').bind(user,id).first<WriteDevice>();
  return assertWritableDevice(row);
}

/** VALUES always attempts one row. EXISTS returns 0, including when the domain vanished. */
export function guard(db:D1Database,h:Domain,op:string,device?:WriteDevice,job?:JobLease):D1PreparedStatement {
  const args:unknown[]=[h.user_id,op,h.user_id,h.active_epoch,h.write_version];
  let predicate='h.user_id=? AND h.active_epoch=? AND h.write_version=?';
  if(device){predicate+=' AND EXISTS(SELECT 1 FROM devices d WHERE d.user_id=h.user_id AND d.id=? AND d.token_hash=? AND d.auth_version=? AND d.paused=0 AND d.revoked_at IS NULL AND d.history_deleted_at IS NULL)';args.push(device.id,device.token_hash,device.auth_version);}
  if(job){predicate+=" AND EXISTS(SELECT 1 FROM v3_jobs j WHERE j.user_id=h.user_id AND j.job_id=? AND j.lease_token=? AND j.state='running' AND j.lease_until>?)";args.push(job.job_id,job.lease_token,Date.now());}
  return db.prepare(`INSERT INTO v3_apply_guards(user_id,operation_id,ok) VALUES(?,?,EXISTS(SELECT 1 FROM v3_sync_domains h WHERE ${predicate}))`).bind(...args);
}

export function endGuard(db:D1Database,user:string,op:string) {return db.prepare('DELETE FROM v3_apply_guards WHERE user_id=? AND operation_id=?').bind(user,op);}

export function isCasFailure(error:unknown):boolean {return error instanceof Error&&/CHECK constraint failed.*ok\s*=\s*1/i.test(error.message);}

export async function receipt(db:D1Database,user:string,id:string):Promise<Receipt|null> {return db.prepare('SELECT * FROM v3_receipts WHERE user_id=? AND batch_id=?').bind(user,id).first<Receipt>();}

export function assertReceipt(row:Receipt,batch:UploadBatch,wireHash:string,device:string) {
  if(row.device_id!==device||row.wire_hash!==wireHash||row.records_hash!==batch.records_hash||row.collector_id!==batch.collector_id||row.producer_epoch!==batch.producer_epoch||row.lane!==batch.lane||row.lane_seq!==batch.lane_seq)
    fail(409,'BATCH_CONFLICT','批次标识或序号已经对应其他内容。');
}

export async function acknowledge(db:D1Database,h:Domain,row:Receipt):Promise<UploadAck> {
  const p=await db.prepare('SELECT received_seq,applied_seq FROM v3_producer_progress WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=?').bind(row.user_id,row.collector_id,row.producer_epoch,row.lane).first<{received_seq:number;applied_seq:number}>();
  return acknowledgement(h,row,p);
}

function acknowledgement(h:Pick<Domain,'active_epoch'|'config_version'>,row:Receipt,p:{received_seq:number;applied_seq:number}|null):UploadAck {
  if(row.status==='cancelled'||row.status==='failed')return fail(409,row.error_code||'BATCH_CANCELLED','批次未应用，请根据错误恢复对应来源。');
  return {batch_id:row.batch_id,wire_hash:row.wire_hash,records_hash:row.records_hash,status:row.status,received_at:new Date(row.received_at).toISOString(),dataset_epoch:row.applied_epoch||h.active_epoch,applied_commit_seq:row.applied_commit_seq,contiguous_received_seq:p?.received_seq||0,contiguous_applied_seq:p?.applied_seq||0,retry_after_ms:row.status==='received'?1000:0,current_config_version:h.config_version};
}

export async function readAcknowledgement(db:D1Database,user:string,id:string,device:string):Promise<UploadAck> {
  const row=await db.prepare(`SELECT r.*,h.active_epoch,h.config_version,p.received_seq,p.applied_seq FROM v3_receipts r JOIN v3_sync_domains h ON h.user_id=r.user_id LEFT JOIN v3_producer_progress p ON (p.user_id,p.collector_id,p.producer_epoch,p.lane)=(r.user_id,r.collector_id,r.producer_epoch,r.lane) WHERE r.user_id=? AND r.batch_id=? AND r.device_id=?`).bind(user,id,device).first<Receipt&Pick<Domain,'active_epoch'|'config_version'>&{received_seq:number;applied_seq:number}>();
  if(!row)return fail(404,'NOT_FOUND','批次不存在。');return acknowledgement(row,row,row);
}

/** Start at the contiguous watermark, never MAX(received sequence). */
export function progressStatements(db:D1Database,b:UploadBatch,user:string):D1PreparedStatement[] {
  return (['received','applied'] as const).map(kind=>{
    const field=kind==='received'?'received_seq':'applied_seq';
    const statuses=kind==='received'?"('received','applied','failed','cancelled')":"('applied')";
    return db.prepare(`WITH RECURSIVE contiguous(n) AS (
      SELECT ${field} FROM v3_producer_progress WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=?
      UNION ALL SELECT n+1 FROM contiguous WHERE EXISTS(SELECT 1 FROM v3_receipts WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=? AND lane_seq=n+1 AND status IN ${statuses})
    ) UPDATE v3_producer_progress SET ${field}=COALESCE((SELECT MAX(n) FROM contiguous),0) WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=?`).bind(...Array(3).fill([user,b.collector_id,b.producer_epoch,b.lane]).flat());
  });
}

export async function receive(db:D1Database,device:WriteDevice,b:UploadBatch,wire:Uint8Array,wireHash:string):Promise<Receipt> {
  for(let attempt=0;attempt<3;attempt++){
    const context=await db.batch([db.prepare('SELECT * FROM v3_receipts WHERE user_id=? AND batch_id=?').bind(device.user_id,b.batch_id),db.prepare('SELECT * FROM v3_sync_domains WHERE user_id=?').bind(device.user_id),db.prepare('SELECT device_id FROM v3_collectors WHERE user_id=? AND collector_id=?').bind(device.user_id,b.collector_id)]);
    const old=context[0].results[0] as Receipt|undefined;if(old){assertReceipt(old,b,wireHash,device.id);return old;}
    const h=(context[1].results[0] as Domain|undefined)||await domain(db,device.user_id),now=Date.now(),op=crypto.randomUUID(),owner=context[2].results[0] as {device_id:string}|undefined;
    if(owner&&owner.device_id!==device.id)fail(409,'COLLECTOR_BOUND','采集身份已属于另一台设备。');
    try {
      await db.batch([
        guard(db,h,op,device),
        db.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,collector_id) DO NOTHING').bind(device.user_id,b.collector_id,device.id,now),
        db.prepare('INSERT INTO v3_apply_guards(user_id,operation_id,ok) VALUES(?,?,EXISTS(SELECT 1 FROM v3_collectors WHERE user_id=? AND collector_id=? AND device_id=?))').bind(device.user_id,op+':collector',device.user_id,b.collector_id,device.id),
        db.prepare('INSERT INTO v3_producer_progress(user_id,collector_id,producer_epoch,lane) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(device.user_id,b.collector_id,b.producer_epoch,b.lane),
        db.prepare("INSERT INTO v3_receipts(user_id,batch_id,device_id,collector_id,producer_epoch,lane,lane_seq,wire_hash,records_hash,status,received_at) VALUES(?,?,?,?,?,?,?,?,?,'received',?)").bind(device.user_id,b.batch_id,device.id,b.collector_id,b.producer_epoch,b.lane,b.lane_seq,wireHash,b.records_hash,now),
        db.prepare('INSERT INTO v3_pending_inputs(user_id,batch_id,wire) VALUES(?,?,?)').bind(device.user_id,b.batch_id,wire),
        db.prepare("INSERT INTO v3_jobs(user_id,job_id,kind,device_id,payload,created_at,updated_at) VALUES(?,?,'apply',?,?,?,?)").bind(device.user_id,'apply:'+b.batch_id,device.id,stableJson({batch_id:b.batch_id}),now,now),
        ...progressStatements(db,b,device.user_id),endGuard(db,device.user_id,op+':collector'),endGuard(db,device.user_id,op),
      ]);
      return {user_id:device.user_id,batch_id:b.batch_id,device_id:device.id,collector_id:b.collector_id,producer_epoch:b.producer_epoch,lane:b.lane,lane_seq:b.lane_seq,wire_hash:wireHash,records_hash:b.records_hash,status:'received',received_at:now,applied_epoch:null,applied_commit_seq:null,error_code:null};
    }catch(error){
      const saved=await receipt(db,device.user_id,b.batch_id);if(saved){assertReceipt(saved,b,wireHash,device.id);return saved;}
      if(error instanceof Error&&/UNIQUE constraint failed.*v3_receipts/.test(error.message))fail(409,'SEQUENCE_CONFLICT','通道序号已经对应另一批次。');
      if(isCasFailure(error)){await currentDevice(db,device.user_id,device.id);continue;}throw error;
    }
  }
  return fail(409,'WRITE_CONFLICT','数据正在更新，请重试同一批次。');
}

export async function entityStatements(db:D1Database,h:Domain,changes:EntityMutation[]):Promise<D1PreparedStatement[]> {
  if(!changes.length)return [];
  const seen=new Set<string>();for(const c of changes){const key=stableJson([c.kind,c.id]);if(seen.has(key))throw Error('duplicate entity mutation');seen.add(key);}
  const rows=await Promise.all(changes.map(async c=>({...c,payload:c.value===null?null:stableJson(c.value),hash:await sha256(stableJson(c.value))})));
  const seq=h.commit_seq+1,out:D1PreparedStatement[]=[db.prepare('INSERT INTO v3_commits(user_id,epoch,commit_seq,created_at,entity_count) VALUES(?,?,?,?,?)').bind(h.user_id,h.active_epoch,seq,Date.now(),rows.length)];
  for(const chunk of chunks(rows)){
    const raw=stableJson(chunk);
    out.push(db.prepare(`UPDATE v3_entity_versions SET valid_to=? WHERE rowid IN(SELECT v.rowid FROM json_each(?) j CROSS JOIN v3_entity_versions v WHERE v.user_id=? AND v.epoch=? AND v.valid_to IS NULL AND v.kind=json_extract(j.value,'$.kind') AND v.entity_id=json_extract(j.value,'$.id'))`).bind(seq,raw,h.user_id,h.active_epoch));
    out.push(db.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,at,thread_id,origin_device_id,payload)
      SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),?,json_extract(value,'$.revision'),json_extract(value,'$.hash'),json_extract(value,'$.at'),json_extract(value,'$.thread_id'),json_extract(value,'$.origin_device_id'),json_extract(value,'$.payload') FROM json_each(?)`).bind(h.user_id,h.active_epoch,seq,raw));
    out.push(db.prepare(`INSERT INTO v3_changes(user_id,epoch,commit_seq,kind,entity_id,revision,hash,payload) SELECT ?,?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.revision'),json_extract(value,'$.hash'),json_extract(value,'$.payload') FROM json_each(?)`).bind(h.user_id,h.active_epoch,seq,raw));
  }
  return out;
}

export function advanceHead(db:D1Database,h:Domain,hasChanges:boolean) {return db.prepare('UPDATE v3_sync_domains SET write_version=write_version+1,commit_seq=commit_seq+?,updated_at=? WHERE user_id=?').bind(hasChanges?1:0,Date.now(),h.user_id);}

export { chunks } from '../../foundation/chunks.js';
