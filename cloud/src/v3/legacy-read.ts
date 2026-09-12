import { fail } from '../http';

/** Only the initial, entirely v2 history may use the compatibility reader. Later v3
 * contributions or retired heads would make v2 alone an incomplete account view. */
async function legacyReadVersion(db:D1Database,user:string):Promise<string|null> {
  const row=await db.prepare(`SELECT CAST(h.write_version AS TEXT) version FROM v3_sync_domains h WHERE h.user_id=?
    AND h.legacy_baseline_pending=1 AND h.mode<>'deleting'
    AND EXISTS(SELECT 1 FROM usage_heads u WHERE u.user_id=h.user_id)
    AND NOT EXISTS(SELECT 1 FROM v3_receipts r WHERE r.user_id=h.user_id AND r.status='applied')
    AND NOT EXISTS(SELECT 1 FROM v3_legacy_heads l WHERE l.user_id=h.user_id AND l.retired_revision>0)
    AND NOT EXISTS(SELECT 1 FROM devices d JOIN usage_heads u ON u.user_id=d.user_id AND u.device_id=d.id WHERE d.user_id=h.user_id AND d.history_deleted_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM usage_heads u LEFT JOIN usage_revisions r USING(user_id,device_id,dataset_id,thread_id,revision) WHERE u.user_id=h.user_id AND COALESCE(r.committed,0)<>1)`)
    .bind(user).first<{version:string}>();
  return row?.version??null;
}
export async function legacyReadAvailable(db:D1Database,user:string):Promise<boolean> {return await legacyReadVersion(db,user)!==null;}

export async function assertLegacyRead(db:D1Database,user:string,expectedVersion?:string):Promise<string> {
  const version=await legacyReadVersion(db,user);
  if(version===null||expectedVersion!==undefined&&version!==expectedVersion)return fail(409,'LEGACY_VIEW_EXPIRED','旧版历史视图已更新，请重新读取同步状态。');
  return version;
}
