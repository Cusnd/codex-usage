import { stableJson, type EntityKind, type SnapshotManifestPage } from "../../contracts/sync.js";
import { fail } from "../../platform/worker/http.js";
import { getRead } from './leases.js';
import { decodeCursor, readScope, versionAtCut, entityWithinScope } from './scope.js';
import { type Version, MINUTE, leaseCut } from './model.js';

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
