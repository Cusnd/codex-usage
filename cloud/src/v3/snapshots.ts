import { stableJson, type ChangesPage, type EntityKind, type SnapshotManifestPage, type SyncCut } from '../../../shared/sync-v3';
import { fail } from '../http';
import { domain, cutOf, type Domain } from './store';
import { defaultSettings } from './defaults';

export type ReadLease={user_id:string;lease_id:string;epoch:string;cut:number;deletion_version:number;organization_version:number;config_version:number;scope:'recent'|'full';from_at:string|null;device_ids:string;created_at:number;expires_at:number;max_expires_at:number;coverage:string;settings:string|null};
type Version={kind:EntityKind;entity_id:string;revision:number;hash:string;payload:string|null};
const MINUTE=60_000;
const leaseCut=(r:ReadLease):SyncCut=>({dataset_epoch:r.epoch,commit_seq:r.cut,deletion_version:r.deletion_version,organization_version:r.organization_version,config_version:r.config_version});
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
const eventWithinScope=(v='v',pointwise=false)=>`(json_array_length(l.device_ids)=0 OR ${v}.origin_device_id IN(SELECT value FROM json_each(l.device_ids))) AND (l.scope='full' OR ${v}.at>=l.from_at OR ${pointwise?`EXISTS(SELECT 1 FROM v3_entity_versions recent WHERE ${versionAtCut('recent')} AND recent.kind='event' AND recent.thread_id=${v}.thread_id AND recent.at>=l.from_at)`:v+'.thread_id IN(SELECT thread_id FROM recent_threads)'})`;
const metadataWithinScope=(v='v')=>`(${v}.kind<>'thread' OR l.scope='full' AND json_array_length(l.device_ids)=0 OR ${v}.entity_id IN(SELECT id FROM related_threads))`;
const versionAtCut=(v='v')=>`${v}.user_id=l.user_id AND ${v}.epoch=l.epoch AND ${v}.valid_from<=l.cut AND (${v}.valid_to IS NULL OR l.cut<${v}.valid_to) AND ${v}.payload IS NOT NULL`;
const entityWithinScope=(v='v')=>`((${v}.kind='event' AND ${eventWithinScope(v,true)}) OR (${v}.kind<>'event' AND ${metadataWithinScope(v)}))`;
/** Every data query checks the lease again inside the same statement as the entity read. */
export function readScope() {
  return `WITH RECURSIVE lease AS (SELECT l.* FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'),
    versions AS (SELECT v.* FROM v3_entity_versions v JOIN lease l ON v.user_id=l.user_id AND v.epoch=l.epoch WHERE v.valid_from<=l.cut AND (v.valid_to IS NULL OR l.cut<v.valid_to) AND v.payload IS NOT NULL),
    recent_threads AS (SELECT DISTINCT v.thread_id FROM versions v CROSS JOIN lease l WHERE v.kind='event' AND v.at>=l.from_at),
    selected_events AS (SELECT v.* FROM versions v CROSS JOIN lease l WHERE v.kind='event' AND ${eventWithinScope()}),
    related_threads(id) AS (SELECT DISTINCT thread_id FROM selected_events UNION SELECT json_extract(t.payload,'$.parent_id') FROM versions t JOIN related_threads e ON e.id=t.entity_id WHERE t.kind='thread' AND json_extract(t.payload,'$.parent_id') IS NOT NULL),
    scoped AS (SELECT * FROM selected_events UNION ALL SELECT v.* FROM versions v CROSS JOIN lease l WHERE v.kind<>'event' AND ${metadataWithinScope()})`;
}
function decodeCursor(value:string|null):[string,string]|null {
  if(value===null)return null;
  try{const decoded=JSON.parse(atob(value));if(Array.isArray(decoded)&&decoded.length===2&&decoded.every(x=>typeof x==='string'&&x.length<=2048))return decoded as [string,string];}catch{}return fail(400,'INVALID_CURSOR','分页游标无效。');
}
export async function manifest(db:D1Database,user:string,id:string,cursor:string|null,limit=200):Promise<SnapshotManifestPage> {
  if(!Number.isInteger(limit)||limit<1||limit>500)fail(400,'INVALID_LIMIT','分页大小无效。');
  const lease=await getRead(db,user,id),after=decodeCursor(cursor),now=Date.now();
  // Apply the keyset to the indexed physical version rows before testing their scope.
  const {results}=await db.prepare(readScope()+` SELECT v.kind,v.entity_id,v.revision,v.hash FROM lease l CROSS JOIN v3_entity_versions v WHERE ${versionAtCut()} AND ${entityWithinScope()} ${after?'AND (v.kind,v.entity_id)>(?,?)':''} ORDER BY v.kind,v.entity_id LIMIT ?`).bind(user,id,now,...after??[],limit+1).all<Version>();
  await getRead(db,user,id); // A concurrent delete must not turn an expired lease into a complete empty page.
  const more=results.length>limit,rows=results.slice(0,limit),last=rows.at(-1);
  await db.prepare('UPDATE v3_read_leases SET expires_at=MIN(max_expires_at,?) WHERE user_id=? AND lease_id=? AND expires_at>?').bind(now+15*MINUTE,user,id,now).run();
  return {lease_id:id,cut:leaseCut(lease),scope:lease.scope,entities:rows.map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,hash:r.hash})),next_cursor:more&&last?btoa(JSON.stringify([last.kind,last.entity_id])):null,expires_at:new Date(Math.min(lease.max_expires_at,now+15*MINUTE)).toISOString()};
}
export async function entities(db:D1Database,user:string,id:string,keys:{kind:EntityKind;id:string;revision?:number;hash?:string}[]) {
  if(!Array.isArray(keys)||keys.length>200||keys.some(x=>!x||typeof x.kind!=='string'||typeof x.id!=='string'||x.id.length>2048)||new Set(keys.map(x=>stableJson([x.kind,x.id]))).size!==keys.length)fail(400,'INVALID_ENTITIES','实体请求无效。');
  // Drive from the requested keys. Keeping this join outside the scoped UNION prevents
  // SQLite from reversing it into a scan of all historical entities for every key list.
  const lease=await getRead(db,user,id),{results}=await db.prepare(readScope()+` SELECT v.kind,v.entity_id,v.revision,v.hash,v.payload FROM json_each(?) k CROSS JOIN lease l CROSS JOIN v3_entity_versions v WHERE ${versionAtCut()} AND v.kind=json_extract(k.value,'$.kind') AND v.entity_id=json_extract(k.value,'$.id') AND ${entityWithinScope()} ORDER BY v.kind,v.entity_id`).bind(user,id,Date.now(),stableJson(keys)).all<Version>();
  await getRead(db,user,id);
  if(results.length!==keys.length)fail(404,'ENTITY_OUTSIDE_SCOPE','实体不属于当前读取范围。');
  for(const row of results){const key=keys.find(k=>k.kind===row.kind&&k.id===row.entity_id)!;if(key.revision!==undefined&&key.revision!==row.revision||key.hash!==undefined&&key.hash!==row.hash)fail(409,'ENTITY_REVISION_MISMATCH','实体版本与清单不符。');}
  return {lease_id:id,cut:leaseCut(lease),entities:results.map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,hash:r.hash,value:JSON.parse(r.payload!)}))};
}
export async function changes(db:D1Database,user:string,epoch:string,after:number,limit=20,leaseId?:string):Promise<ChangesPage> {
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'INVALID_CURSOR','变化游标无效。');
  const h=await domain(db,user);if(h.active_epoch!==epoch||after<h.changes_floor||after>h.commit_seq||h.mode==='deleting')fail(409,'BASELINE_REQUIRED','需要新的完整同步基线。');if(h.mode==='rebuilding')fail(409,'DATASET_UPDATING','历史基线正在后台构建。');
  const lease=leaseId?await getRead(db,user,leaseId):null;if(lease&&lease.epoch!==epoch)fail(409,'BASELINE_REQUIRED','读取版本已变化。');const target=lease?.cut??h.commit_seq;if(after>target)fail(400,'INVALID_CURSOR','变化游标超出固定版本。');
  const commits=await db.prepare('SELECT commit_seq,entity_count FROM v3_commits WHERE user_id=? AND epoch=? AND commit_seq>? AND commit_seq<=? ORDER BY commit_seq LIMIT ?').bind(user,epoch,after,target,limit).all<{commit_seq:number;entity_count:number}>();
  let count=0;const selected:typeof commits.results=[];for(const c of commits.results){if(count&&count+c.entity_count>1000)break;count+=c.entity_count;selected.push(c);}
  const sequences=selected.map(r=>r.commit_seq),rows=sequences.length?await db.prepare('SELECT * FROM v3_changes WHERE user_id=? AND epoch=? AND commit_seq IN(SELECT value FROM json_each(?)) ORDER BY commit_seq,kind,entity_id').bind(user,epoch,stableJson(sequences)).all<Version&{commit_seq:number}>():{results:[]};
  const current=await domain(db,user);if(current.deletion_version!==h.deletion_version||current.active_epoch!==h.active_epoch||current.mode==='deleting')fail(409,'BASELINE_REQUIRED','读取版本已失效。');
  const output=selected.map(c=>{const group=rows.results.filter(r=>r.commit_seq===c.commit_seq);if(group.length!==c.entity_count)fail(409,'BASELINE_REQUIRED','变化记录不完整。');return {commit_seq:c.commit_seq,entity_count:c.entity_count,complete:true,entities:group.filter(r=>r.payload!==null).map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,hash:r.hash,value:JSON.parse(r.payload!)})),deleted:group.filter(r=>r.payload===null).map(r=>({kind:r.kind,id:r.entity_id}))};});
  const next=sequences.at(-1)??after;return {cut:lease?leaseCut(lease):cutOf(h),commits:output,next_cursor:next,more:next<target};
}
export async function cleanupVersions(db:D1Database,now=Date.now()) {
  await db.prepare('DELETE FROM v3_read_leases WHERE expires_at<=?').bind(now).run();
  // Keep seven days of change history. Old versions are retained for active leases independently.
  const domains=await db.prepare('SELECT * FROM v3_sync_domains LIMIT 100').all<Domain>();
  for(const h of domains.results){const floor=await db.prepare('SELECT MAX(commit_seq) AS floor FROM v3_commits WHERE user_id=? AND epoch=? AND created_at<?').bind(h.user_id,h.active_epoch,now-7*86400_000).first<number>('floor');if(floor!==null){await db.batch([db.prepare('UPDATE v3_sync_domains SET changes_floor=MAX(changes_floor,?) WHERE user_id=?').bind(floor,h.user_id),db.prepare('DELETE FROM v3_commits WHERE user_id=? AND epoch=? AND commit_seq<=?').bind(h.user_id,h.active_epoch,floor)]);}}
  await db.prepare(`DELETE FROM v3_entity_versions WHERE rowid IN(SELECT v.rowid FROM v3_entity_versions v JOIN v3_sync_domains h ON h.user_id=v.user_id WHERE v.valid_to IS NOT NULL AND v.valid_to<=h.changes_floor AND NOT EXISTS(SELECT 1 FROM v3_read_leases l WHERE l.user_id=v.user_id AND l.epoch=v.epoch AND l.cut>=v.valid_from AND l.cut<v.valid_to AND l.expires_at>?) LIMIT 1000)`).bind(now).run();
  // Superseded epochs are retained only while pinned. Never collect a still-building private epoch.
  for(const table of ['v3_entity_versions','v3_events','v3_aggregates','v3_aggregate_members','v3_commits'])await db.prepare(`DELETE FROM ${table} WHERE rowid IN(SELECT v.rowid FROM ${table} v JOIN v3_sync_domains h ON h.user_id=v.user_id WHERE v.epoch<>h.active_epoch AND NOT EXISTS(SELECT 1 FROM v3_read_leases l WHERE l.user_id=v.user_id AND l.epoch=v.epoch AND l.expires_at>?) AND NOT EXISTS(SELECT 1 FROM v3_jobs j WHERE j.user_id=v.user_id AND j.state IN('pending','running') AND json_extract(j.checkpoint,'$.epoch')=v.epoch) LIMIT 1000)`).bind(now).run();
}
