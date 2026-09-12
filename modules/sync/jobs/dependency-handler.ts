import { stableJson } from "../../contracts/sync.js";
import { consumeProjected, initialLegacyState } from "../../usage/normalize.js";
import type { LegacyState, Observation } from "../../usage/types.js";
import { sha256 } from "../../platform/worker/http.js";
import { advanceHead, chunks, domain, endGuard, entityStatements, guard } from "../publication/store.js";
import type { CandidateRow } from "../../usage/candidate-row.js";
import { prepareMaterialization } from "../apply/materialization.js";
import { type Job } from "./types.js";
import { failJob } from './recovery.js';

export async function dependencyStep(db: D1Database, job: Job): Promise<boolean> {
    const h = await domain(db, job.user_id);
    if (h.mode !== 'ready')
        return false;
    const p = JSON.parse(job.payload) as {
        collector_id: string;
        source_id: string;
        generation: number;
    }, args = [job.user_id, p.collector_id, p.source_id, p.generation];
    const source = await db.prepare('SELECT active,parser_state FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args).first<{
        active: number;
        parser_state: string | null;
    }>();
    if (!source?.active) {
        await failJob(db, job, 'SOURCE_REPLACED', true);
        return true;
    }
    const parentRows = (await db.prepare('SELECT parent_thread_id,initial_state FROM v3_dependencies WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args).all<{
        parent_thread_id: string;
        initial_state: string | null;
    }>()).results, parents = parentRows.map(r => r.parent_thread_id);
    const complete = (await db.prepare('SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND s.active=1 AND s.complete=1 AND t.thread_id IN(SELECT value FROM json_each(?))').bind(job.user_id, stableJson(parents)).all<{
        thread_id: string;
    }>()).results;
    if (parents.some(id => !complete.some(r => r.thread_id === id)))
        return false;
    const signatures = (await db.prepare('SELECT thread_id,at,signature FROM v3_candidates WHERE user_id=? AND active=1 AND thread_id IN(SELECT value FROM json_each(?)) AND signature IS NOT NULL').bind(job.user_id, stableJson(parents)).all<{
        thread_id: string;
        at: string;
        signature: string;
    }>()).results;
    const parentHash = await sha256(stableJson(signatures.sort((a, b) => stableJson(a).localeCompare(stableJson(b))))), checkpoint = JSON.parse(job.checkpoint) as {
        parent_hash?: string;
        last_locator?: number;
        state?: LegacyState;
    }, same = checkpoint.parent_hash === parentHash;
    const records = (await db.prepare('SELECT observation FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND source_id=? AND generation=? AND locator>? ORDER BY locator LIMIT 501').bind(...args, same ? checkpoint.last_locator ?? -1 : -1).all<{
        observation: string;
    }>()).results.map(r => JSON.parse(r.observation) as Observation), more = records.length > 500;
    records.splice(500);
    if (!records.length) {
        await db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0 WHERE user_id=? AND job_id=? AND lease_token=?").bind(job.user_id, job.job_id, job.lease_token).run();
        return true;
    }
    const prior = (await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(job.user_id, stableJson(records.map(r => r.observation_id))).all<CandidateRow>()).results, owner = await db.prepare('SELECT device_id FROM v3_collectors WHERE user_id=? AND collector_id=?').bind(job.user_id, p.collector_id).first<string>('device_id');
    let state: LegacyState = same && checkpoint.state ? checkpoint.state : parentRows[0]?.initial_state ? JSON.parse(parentRows[0].initial_state) : initialLegacyState(records[0].context.thread_id);
    const mutations = new Map<string, CandidateRow | null>();
    for (const r of records) {
        const parsed = consumeProjected(state, r, { parentStatus: () => 'complete', parentHasSignature: (id, s, cut) => signatures.some(v => v.thread_id === id && v.signature === s && v.at <= cut) });
        state = parsed.state;
        mutations.set(r.observation_id, null);
        for (const c of parsed.candidates)
            mutations.set(r.observation_id, { observation_id: c.observation_id, uploader_device_id: owner!, collector_id: p.collector_id, source_id: p.source_id, generation: p.generation, record_revision: c.record_revision, event_id: c.event_id, thread_id: c.thread_id, turn_id: c.turn_id, at: c.at, signature: c.signature, active: 1, candidate: stableJson(c) });
    }
    const prepared = await prepareMaterialization(db, h, prior, mutations), op = crypto.randomUUID(), statements: D1PreparedStatement[] = [guard(db, h, op, undefined, job)];
    for (const group of chunks([...mutations.values()].filter((c): c is CandidateRow => !!c)))
        statements.push(db.prepare(`UPDATE v3_candidates SET candidate=(SELECT json_extract(value,'$.candidate') FROM json_each(?) WHERE observation_id=json_extract(value,'$.observation_id')) WHERE user_id=? AND observation_id IN(SELECT json_extract(value,'$.observation_id') FROM json_each(?))`).bind(stableJson(group), job.user_id, stableJson(group)));
    const removed = [...mutations].filter(([, c]) => !c).map(([id]) => id);
    if (removed.length)
        statements.push(db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(job.user_id, stableJson(removed)));
    statements.push(...prepared.statements, ...await entityStatements(db, h, prepared.changes), advanceHead(db, h, prepared.changes.length > 0));
    if (!more) {
        const current: LegacyState = source.parser_state ? JSON.parse(source.parser_state) : state;
        statements.push(db.prepare('UPDATE v3_sources SET parser_state=? WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(stableJson({ ...current, inherited: current.inherited && state.inherited, deferred: false }), ...args), db.prepare('DELETE FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args), db.prepare('DELETE FROM v3_dependencies WHERE user_id=? AND collector_id=? AND source_id=? AND generation=?').bind(...args));
    }
    statements.push(db.prepare('UPDATE v3_jobs SET state=?,checkpoint=?,lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?').bind(more ? 'pending' : 'complete', stableJson({ parent_hash: parentHash, last_locator: records.at(-1)!.locator, state }), Date.now(), job.user_id, job.job_id), endGuard(db, job.user_id, op));
    await db.batch(statements);
    return !more;
}
