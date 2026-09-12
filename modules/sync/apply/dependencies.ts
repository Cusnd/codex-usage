import { stableJson } from "../../contracts/sync.js";
import type { Observation } from "../../usage/types.js";

export async function dependencies(db: D1Database, user: string, records: Observation[]) {
    const ids = [...new Set(records.map(r => r.context.forked_from_id || r.context.subagent_parent_id).filter((x): x is string => !!x))];
    const signatures = ids.length ? (await db.prepare('SELECT thread_id,signature,at FROM v3_candidates WHERE user_id=? AND active=1 AND signature IS NOT NULL AND thread_id IN(SELECT value FROM json_each(?))').bind(user, stableJson(ids)).all<{
        thread_id: string;
        signature: string;
        at: string;
    }>()).results : [];
    const complete = ids.length ? (await db.prepare(`SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND s.active=1 AND s.complete=1 AND t.thread_id IN(SELECT value FROM json_each(?))`).bind(user, stableJson(ids)).all<{
        thread_id: string;
    }>()).results : [];
    return { parentStatus: (id: string, _cutoff: string): 'complete' | 'partial' | 'missing' => complete.some(r => r.thread_id === id) ? 'complete' : signatures.some(r => r.thread_id === id) ? 'partial' : 'missing', parentHasSignature: (id: string, s: string, cut: string) => signatures.some(r => r.thread_id === id && r.signature === s && r.at <= cut) };
}
