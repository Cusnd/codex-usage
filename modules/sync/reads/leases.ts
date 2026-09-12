import { stableJson, type EntityKind } from "../../contracts/sync.js";
import { fail } from "../../platform/worker/http.js";
import { domain } from "../publication/store.js";
import { defaultSettings } from "../../settings/defaults.js";
import { MINUTE, leaseCut, type ReadLease } from './model.js';
import { readScope } from './scope.js';

export async function assertDeviceScope(db:D1Database,user:string,ids:string[]) {
  if(ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(ids).size!==ids.length)fail(400,'INVALID_SCOPE','设备范围无效。');
  if(ids.length){const n=await db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=? AND id IN(SELECT value FROM json_each(?))').bind(user,stableJson(ids)).first<number>('n');if(n!==ids.length)fail(404,'NOT_FOUND','设备不存在。');}
}

export async function createRead(db:D1Database,user:string,scope:'recent'|'full',devices:string[]=[],fromLeaseId?:string) {
  await assertDeviceScope(db,user,devices);const h=await domain(db,user);if(h.mode==='deleting')fail(409,'HISTORY_UPDATING','历史删除正在处理。');if(!fromLeaseId&&(h.mode==='rebuilding'))fail(409,'DATASET_UPDATING','完整历史正在后台准备，完成后将自动显示。');
  const id=crypto.randomUUID(),now=Date.now();
  if(fromLeaseId){await getRead(db,user,fromLeaseId);await db.prepare(`INSERT INTO v3_read_leases(user_id,lease_id,epoch,cut,deletion_version,organization_version,config_version,scope,from_at,device_ids,created_at,expires_at,max_expires_at,coverage,settings)
    SELECT l.user_id,?,l.epoch,l.cut,l.deletion_version,l.organization_version,l.config_version,?,?,?,l.created_at,MIN(l.max_expires_at,?),l.max_expires_at,l.coverage,l.settings FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'`).bind(id,scope,scope==='recent'?new Date(now-30*86400_000).toISOString():null,stableJson(devices),now+15*MINUTE,user,fromLeaseId,now).run();}
  else await db.prepare(`INSERT INTO v3_read_leases(user_id,lease_id,epoch,cut,deletion_version,organization_version,config_version,scope,from_at,device_ids,created_at,expires_at,max_expires_at,coverage,settings)
    SELECT user_id,?,active_epoch,commit_seq,deletion_version,organization_version,config_version,?,?,?,?,?,?,json_object('sources',json((SELECT COALESCE(json_group_array(json_object('device_id',c.device_id,'collector_id',s.collector_id,'source_id',s.source_id,'generation',s.generation,'cursor',s.cursor,'snapshot_eof',s.snapshot_eof,'complete',s.complete,'active',s.active,'available',s.available,'trailing_bytes',s.trailing_bytes)),'[]') FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE s.user_id=h.user_id))),json_patch(?,COALESCE((SELECT payload FROM v3_settings WHERE user_id=h.user_id),'{}')) FROM v3_sync_domains h WHERE user_id=? AND mode='ready'`).bind(id,scope,scope==='recent'?new Date(now-30*86400_000).toISOString():null,stableJson(devices),now,now+15*MINUTE,now+60*MINUTE,stableJson(defaultSettings),user).run();
  const lease=await getRead(db,user,id),counts=await db.prepare(readScope()+' SELECT v.kind,COUNT(*) count FROM scoped v GROUP BY v.kind ORDER BY v.kind').bind(user,id,now).all<{kind:EntityKind;count:number}>();
  return {lease_id:id,cut:leaseCut(lease),scope,scope_info:{from_at:lease.from_at,includes_recent_threads:true},coverage:JSON.parse(lease.coverage),settings:{...defaultSettings,...(lease.settings?JSON.parse(lease.settings):{})},expected_entities:counts.results,total_entities:counts.results.reduce((n,r)=>n+r.count,0),expires_at:new Date(lease.expires_at).toISOString()};
}

export async function getRead(db:D1Database,user:string,id:string):Promise<ReadLease> {
  const r=await db.prepare(`SELECT l.* FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'`).bind(user,id,Date.now()).first<ReadLease>();
  if(!r)return fail(409,'BASELINE_REQUIRED','读取版本已失效，请重新同步。');return r;
}
