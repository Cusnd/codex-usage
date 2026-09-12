import { fail } from "../../platform/worker/http.js";

const eventWithinScope=(v='v',pointwise=false)=>`(json_array_length(l.device_ids)=0 OR ${v}.origin_device_id IN(SELECT value FROM json_each(l.device_ids))) AND (l.scope='full' OR ${v}.at>=l.from_at OR ${pointwise?`EXISTS(SELECT 1 FROM v3_entity_versions recent WHERE ${versionAtCut('recent')} AND recent.kind='event' AND recent.thread_id=${v}.thread_id AND recent.at>=l.from_at)`:v+'.thread_id IN(SELECT thread_id FROM recent_threads)'})`;

const metadataWithinScope=(v='v')=>`(${v}.kind<>'thread' OR l.scope='full' AND json_array_length(l.device_ids)=0 OR ${v}.entity_id IN(SELECT id FROM related_threads))`;

export const versionAtCut = (v = 'v') => `${v}.user_id=l.user_id AND ${v}.epoch=l.epoch AND ${v}.valid_from<=l.cut AND (${v}.valid_to IS NULL OR l.cut<${v}.valid_to) AND ${v}.payload IS NOT NULL`;

export const entityWithinScope = (v = 'v') => `((${v}.kind='event' AND ${eventWithinScope(v, true)}) OR (${v}.kind<>'event' AND ${metadataWithinScope(v)}))`;

/** Every data query checks the lease again inside the same statement as the entity read. */
export function readScope() {
  return `WITH RECURSIVE lease AS (SELECT l.* FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'),
    versions AS (SELECT v.* FROM v3_entity_versions v JOIN lease l ON v.user_id=l.user_id AND v.epoch=l.epoch WHERE v.valid_from<=l.cut AND (v.valid_to IS NULL OR l.cut<v.valid_to) AND v.payload IS NOT NULL),
    recent_threads AS (SELECT DISTINCT v.thread_id FROM versions v CROSS JOIN lease l WHERE v.kind='event' AND v.at>=l.from_at),
    selected_events AS (SELECT v.* FROM versions v CROSS JOIN lease l WHERE v.kind='event' AND ${eventWithinScope()}),
    related_threads(id) AS (SELECT DISTINCT thread_id FROM selected_events UNION SELECT json_extract(t.payload,'$.parent_id') FROM versions t JOIN related_threads e ON e.id=t.entity_id WHERE t.kind='thread' AND json_extract(t.payload,'$.parent_id') IS NOT NULL),
    scoped AS (SELECT * FROM selected_events UNION ALL SELECT v.* FROM versions v CROSS JOIN lease l WHERE v.kind<>'event' AND ${metadataWithinScope()})`;
}

export function decodeCursor(value: string | null): [
    string,
    string
] | null {
    if (value === null)
        return null;
    try {
        const decoded = JSON.parse(atob(value));
        if (Array.isArray(decoded) && decoded.length === 2 && decoded.every(x => typeof x === 'string' && x.length <= 2048))
            return decoded as [
                string,
                string
            ];
    }
    catch { }
    return fail(400, 'INVALID_CURSOR', '分页游标无效。');
}
