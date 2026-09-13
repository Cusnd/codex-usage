import { stableJson, type EntityKind } from "../../contracts/sync.js";
import { fail } from "../../platform/worker/http.js";
import { domain } from "../publication/store.js";
import { defaultSettings } from "../../settings/defaults.js";
import { MINUTE, leaseCut, type ReadLease, type ReadLeaseMetadata, type ReadLeaseSettings } from './model.js';
import { readScope, versionAtCut } from './scope.js';
import type { PageRead } from '../../contracts/read-lease.js';

export async function assertDeviceScope(db:D1Database,user:string,ids:string[]) {
  if(ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(ids).size!==ids.length)fail(400,'INVALID_SCOPE','设备范围无效。');
  if(ids.length){const n=await db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=? AND id IN(SELECT value FROM json_each(?))').bind(user,stableJson(ids)).first<number>('n');if(n!==ids.length)fail(404,'NOT_FOUND','设备不存在。');}
}

const pageReadOf=(lease:ReadLeaseSettings):PageRead=>({
  user_id:lease.user_id,lease_id:lease.lease_id,cut:leaseCut(lease),
  settings:{...defaultSettings,...(lease.settings?JSON.parse(lease.settings):{})},
  expires_at:new Date(lease.expires_at).toISOString(),
});

export async function createPageRead(db:D1Database,user:string,devices:string[]=[]):Promise<PageRead> {
  await assertDeviceScope(db,user,devices);
  const h=await domain(db,user);
  if(h.mode==='deleting')fail(409,'HISTORY_UPDATING','历史删除正在处理。');
  if(h.mode==='rebuilding')fail(409,'DATASET_UPDATING','完整历史正在后台准备，完成后将自动显示。');
  const id=crypto.randomUUID(),now=Date.now();
  // Capture the published cut and its settings in one statement. Online views
  // do not enumerate entity counts or the collector/source coverage inventory.
  await db.prepare(`INSERT INTO v3_read_leases(user_id,lease_id,epoch,cut,deletion_version,organization_version,config_version,scope,from_at,device_ids,created_at,expires_at,max_expires_at,coverage,settings)
    SELECT user_id,?,active_epoch,commit_seq,deletion_version,organization_version,config_version,'full',NULL,?,?,?,?, '{}',
      json_patch(?,COALESCE((SELECT payload FROM v3_settings WHERE user_id=h.user_id),'{}'))
    FROM v3_sync_domains h WHERE user_id=? AND mode='ready'`)
    .bind(id,stableJson(devices),now,now+15*MINUTE,now+60*MINUTE,stableJson(defaultSettings),user).run();
  return pageReadOf(await getRead(db,user,id,'settings'));
}

export async function renewPageRead(db:D1Database,user:string,id:string):Promise<PageRead> {
  const now=Date.now();
  const changed=await db.prepare(`UPDATE v3_read_leases SET expires_at=MIN(max_expires_at,?)
    WHERE user_id=? AND lease_id=? AND expires_at>? AND max_expires_at>?
      AND EXISTS(SELECT 1 FROM v3_sync_domains h WHERE h.user_id=v3_read_leases.user_id
        AND h.deletion_version=v3_read_leases.deletion_version AND h.mode<>'deleting')`)
    .bind(now+15*MINUTE,user,id,now,now).run();
  if(changed.meta.changes!==1)fail(409,'BASELINE_REQUIRED','页面读取版本已失效，请刷新页面。');
  // Match existing lease semantics: a newer head or a rebuild does not revoke
  // an already pinned cut. The final read still rejects deletion or expiry.
  return pageReadOf(await getRead(db,user,id,'settings'));
}

export async function createRead(db:D1Database,user:string,scope:'recent'|'full',devices:string[]=[],fromLeaseId?:string) {
  await assertDeviceScope(db,user,devices);const h=await domain(db,user);if(h.mode==='deleting')fail(409,'HISTORY_UPDATING','历史删除正在处理。');if(!fromLeaseId&&(h.mode==='rebuilding'))fail(409,'DATASET_UPDATING','完整历史正在后台准备，完成后将自动显示。');
  const id=crypto.randomUUID(),now=Date.now();
  if(fromLeaseId){await getRead(db,user,fromLeaseId,'metadata');await db.prepare(`INSERT INTO v3_read_leases(user_id,lease_id,epoch,cut,deletion_version,organization_version,config_version,scope,from_at,device_ids,created_at,expires_at,max_expires_at,coverage,settings)
    SELECT l.user_id,?,l.epoch,l.cut,l.deletion_version,l.organization_version,l.config_version,?,?,?,l.created_at,MIN(l.max_expires_at,?),l.max_expires_at,l.coverage,l.settings FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'`).bind(id,scope,scope==='recent'?new Date(now-30*86400_000).toISOString():null,stableJson(devices),now+15*MINUTE,user,fromLeaseId,now).run();}
  else await db.prepare(`INSERT INTO v3_read_leases(user_id,lease_id,epoch,cut,deletion_version,organization_version,config_version,scope,from_at,device_ids,created_at,expires_at,max_expires_at,coverage,settings)
    SELECT user_id,?,active_epoch,commit_seq,deletion_version,organization_version,config_version,?,?,?,?,?,?,json_object('sources',json((SELECT COALESCE(json_group_array(json_object('device_id',c.device_id,'collector_id',s.collector_id,'source_id',s.source_id,'generation',s.generation,'cursor',s.cursor,'snapshot_eof',s.snapshot_eof,'complete',s.complete,'active',s.active,'available',s.available,'trailing_bytes',s.trailing_bytes)),'[]') FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE s.user_id=h.user_id))),json_patch(?,COALESCE((SELECT payload FROM v3_settings WHERE user_id=h.user_id),'{}')) FROM v3_sync_domains h WHERE user_id=? AND mode='ready'`).bind(id,scope,scope==='recent'?new Date(now-30*86400_000).toISOString():null,stableJson(devices),now,now+15*MINUTE,now+60*MINUTE,stableJson(defaultSettings),user).run();
  // An unfiltered full read includes every live version at its cut. Count those
  // rows directly without materializing payloads through the recursive scope.
  const countSql=scope==='full'&&!devices.length
    ? ` SELECT v.kind,COUNT(*) count FROM lease l CROSS JOIN v3_entity_versions v WHERE ${versionAtCut()} GROUP BY v.kind ORDER BY v.kind`
    : ' SELECT v.kind,COUNT(*) count FROM scoped v GROUP BY v.kind ORDER BY v.kind';
  const lease=await getRead(db,user,id),counts=await db.prepare(readScope()+countSql).bind(user,id,now).all<{kind:EntityKind;count:number}>();
  return {lease_id:id,cut:leaseCut(lease),scope,scope_info:{from_at:lease.from_at,includes_recent_threads:true},coverage:JSON.parse(lease.coverage),settings:{...defaultSettings,...(lease.settings?JSON.parse(lease.settings):{})},expected_entities:counts.results,total_entities:counts.results.reduce((n,r)=>n+r.count,0),expires_at:new Date(lease.expires_at).toISOString()};
}

export function getRead(db:D1Database,user:string,id:string):Promise<ReadLease>;
export function getRead(db:D1Database,user:string,id:string,projection:'metadata'):Promise<ReadLeaseMetadata>;
export function getRead(db:D1Database,user:string,id:string,projection:'settings'):Promise<ReadLeaseSettings>;
export async function getRead(db:D1Database,user:string,id:string,projection:'full'|'metadata'|'settings'='full'):Promise<ReadLease|ReadLeaseMetadata|ReadLeaseSettings> {
  // Keep the same validity predicate for every projection. Coverage is a full
  // source inventory and is only needed when returning a newly created read.
  const columns=projection==='full'?'l.*':`l.user_id,l.lease_id,l.epoch,l.cut,l.deletion_version,l.organization_version,l.config_version,l.scope,l.from_at,l.device_ids,l.created_at,l.expires_at,l.max_expires_at${projection==='settings'?',l.settings':''}`;
  const r=await db.prepare(`SELECT ${columns} FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'`).bind(user,id,Date.now()).first<ReadLease|ReadLeaseMetadata|ReadLeaseSettings>();
  if(!r)return fail(409,'BASELINE_REQUIRED','读取版本已失效，请重新同步。');return r;
}
