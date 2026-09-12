import { type Domain } from "../publication/store.js";

export async function cleanupVersions(db:D1Database,now=Date.now()) {
  await db.prepare('DELETE FROM v3_read_leases WHERE expires_at<=?').bind(now).run();
  // Keep seven days of change history. Old versions are retained for active leases independently.
  const domains=await db.prepare('SELECT * FROM v3_sync_domains LIMIT 100').all<Domain>();
  for(const h of domains.results){const floor=await db.prepare('SELECT MAX(commit_seq) AS floor FROM v3_commits WHERE user_id=? AND epoch=? AND created_at<?').bind(h.user_id,h.active_epoch,now-7*86400_000).first<number>('floor');if(floor!==null){await db.batch([db.prepare('UPDATE v3_sync_domains SET changes_floor=MAX(changes_floor,?) WHERE user_id=?').bind(floor,h.user_id),db.prepare('DELETE FROM v3_commits WHERE user_id=? AND epoch=? AND commit_seq<=?').bind(h.user_id,h.active_epoch,floor)]);}}
  await db.prepare(`DELETE FROM v3_entity_versions WHERE rowid IN(SELECT v.rowid FROM v3_entity_versions v JOIN v3_sync_domains h ON h.user_id=v.user_id WHERE v.valid_to IS NOT NULL AND v.valid_to<=h.changes_floor AND NOT EXISTS(SELECT 1 FROM v3_read_leases l WHERE l.user_id=v.user_id AND l.epoch=v.epoch AND l.cut>=v.valid_from AND l.cut<v.valid_to AND l.expires_at>?) LIMIT 1000)`).bind(now).run();
  // Superseded epochs are retained only while pinned. Never collect a still-building private epoch.
  for(const table of ['v3_entity_versions','v3_events','v3_aggregates','v3_aggregate_members','v3_commits'])await db.prepare(`DELETE FROM ${table} WHERE rowid IN(SELECT v.rowid FROM ${table} v JOIN v3_sync_domains h ON h.user_id=v.user_id WHERE v.epoch<>h.active_epoch AND NOT EXISTS(SELECT 1 FROM v3_read_leases l WHERE l.user_id=v.user_id AND l.epoch=v.epoch AND l.expires_at>?) AND NOT EXISTS(SELECT 1 FROM v3_jobs j WHERE j.user_id=v.user_id AND j.state IN('pending','running') AND json_extract(j.checkpoint,'$.epoch')=v.epoch) LIMIT 1000)`).bind(now).run();
}
