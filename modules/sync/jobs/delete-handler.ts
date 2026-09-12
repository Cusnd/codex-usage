import { stableJson } from "../../contracts/sync.js";
import type { ThreadChange } from "../../usage/types.js";
import { HttpError } from "../../platform/worker/http.js";
import { advanceHead, chunks, domain, endGuard, entityStatements, guard, type EntityMutation } from "../publication/store.js";
import { prepareProjectDeletion } from "../../organization/worker/projects.js";
import { withdrawDeletedTarget } from "./origin-handler.js";
import type { CandidateRow } from "../../usage/candidate-row.js";
import { prepareMaterialization } from "../apply/materialization.js";
import { type Job } from "./types.js";

export async function deleteDeviceStep(db: D1Database, job: Job): Promise<boolean> {
    const user = job.user_id, id = job.device_id!, h = await domain(db, user), device = await db.prepare('SELECT history_deleted_at FROM devices WHERE user_id=? AND id=?').bind(user, id).first<{
        history_deleted_at: number | null;
    }>();
    if (!device || device.history_deleted_at === null)
        throw new HttpError(409, 'DELETE_CANCELLED', '删除状态已改变。');
    if (await withdrawDeletedTarget(db, h, job))
        return false;
    const candidates = (await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND uploader_device_id=? LIMIT 200').bind(user, id).all<CandidateRow>()).results;
    if (candidates.length) {
        const changes = new Map<string, CandidateRow | null>(candidates.map(r => [r.observation_id, null])), prepared = await prepareMaterialization(db, h, candidates, changes, [], true), op = crypto.randomUUID(), removed = prepared.changes.filter(c => c.kind === 'event' && c.value === null).map(c => c.id);
        const retained = [...changes.values()].filter((r): r is CandidateRow => !!r);
        await db.batch([guard(db, h, op, undefined, job), db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user, stableJson(candidates.map(r => r.observation_id))), ...chunks(retained).map(group => db.prepare(`UPDATE v3_candidates SET candidate=(SELECT json_extract(value,'$.candidate') FROM json_each(?) WHERE observation_id=json_extract(value,'$.observation_id')) WHERE user_id=? AND observation_id IN(SELECT json_extract(value,'$.observation_id') FROM json_each(?))`).bind(stableJson(group), user, stableJson(group))), ...removed.length ? [db.prepare('DELETE FROM v3_origin_operation_events WHERE user_id=? AND event_id IN(SELECT value FROM json_each(?))').bind(user, stableJson(removed))] : [], ...prepared.statements, ...await entityStatements(db, h, prepared.changes), advanceHead(db, h, prepared.changes.length > 0), db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(), user, job.job_id), endGuard(db, user, op)]);
        return false;
    }
    // Metadata is also owned by the uploading collector. Keep metadata supplied by another device.
    const ownThreads = (await db.prepare('SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_collectors c USING(user_id,collector_id) WHERE t.user_id=? AND c.device_id=? LIMIT 100').bind(user, id).all<{
        thread_id: string;
    }>()).results;
    if (ownThreads.length) {
        const op = crypto.randomUUID(), changes: EntityMutation[] = [], statements: D1PreparedStatement[] = [];
        for (const { thread_id } of ownThreads) {
            const old = await db.prepare('SELECT payload,revision FROM v3_threads WHERE user_id=? AND thread_id=?').bind(user, thread_id).first<{
                payload: string;
                revision: number;
            }>();
            const remaining = (await db.prepare('SELECT t.payload FROM v3_source_threads t JOIN v3_collectors c USING(user_id,collector_id) JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND t.thread_id=? AND c.device_id<>? AND s.active=1 ORDER BY t.collector_id,t.source_id').bind(user, thread_id, id).all<{
                payload: string;
            }>()).results;
            let value: ThreadChange | null = null;
            for (const row of remaining) {
                const v = JSON.parse(row.payload) as ThreadChange;
                if (!value)
                    value = v;
                else if (v.title !== undefined && (v.title_updated_at || '') > (value.title_updated_at || ''))
                    value = { ...(value as ThreadChange), title: v.title, title_updated_at: v.title_updated_at };
            }
            if (stableJson(value) !== (old?.payload || 'null')) {
                changes.push({ kind: 'thread', id: thread_id, revision: (old?.revision || 0) + 1, value, thread_id });
                statements.push(value ? db.prepare('INSERT INTO v3_threads(user_id,thread_id,payload,revision) VALUES(?,?,?,?) ON CONFLICT(user_id,thread_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision').bind(user, thread_id, stableJson(value), (old?.revision || 0) + 1) : db.prepare('DELETE FROM v3_threads WHERE user_id=? AND thread_id=?').bind(user, thread_id));
            }
        }
        await db.batch([guard(db, h, op, undefined, job), db.prepare('DELETE FROM v3_source_threads WHERE user_id=? AND collector_id IN(SELECT collector_id FROM v3_collectors WHERE user_id=? AND device_id=?) AND thread_id IN(SELECT value FROM json_each(?))').bind(user, user, id, stableJson(ownThreads.map(r => r.thread_id))), ...statements, ...await entityStatements(db, h, changes), advanceHead(db, h, changes.length > 0), db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0 WHERE user_id=? AND job_id=?").bind(user, job.job_id), endGuard(db, user, op)]);
        return false;
    }
    const projects = await prepareProjectDeletion(db, h, id), op = crypto.randomUUID();
    await db.batch([guard(db, h, op, undefined, job),
        ...projects.statements, ...await entityStatements(db, h, projects.changes), advanceHead(db, h, projects.changes.length > 0),
        ...['v3_observations', 'v3_deferred_records', 'v3_dependencies'].map(table => db.prepare(`DELETE FROM ${table} WHERE user_id=? AND collector_id IN(SELECT collector_id FROM v3_collectors WHERE user_id=? AND device_id=?)`).bind(user, user, id)),
        db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id IN(SELECT batch_id FROM v3_receipts WHERE user_id=? AND device_id=?)').bind(user, user, id),
        db.prepare("UPDATE v3_receipts SET status='cancelled',error_code='DEVICE_REVOKED' WHERE user_id=? AND device_id=? AND status='received'").bind(user, id),
        db.prepare("UPDATE v3_jobs SET state='cancelled',lease_token=NULL,lease_until=0 WHERE user_id=? AND device_id=? AND kind='apply' AND state IN('pending','running')").bind(user, id),
        db.prepare('DELETE FROM v3_collectors WHERE user_id=? AND device_id=?').bind(user, id),
        db.prepare('DELETE FROM cloud_accounts WHERE user_id=? AND device_id=?').bind(user, id),
        db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(), user, job.job_id),
        db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN EXISTS(SELECT 1 FROM v3_jobs WHERE user_id=? AND kind='delete_device' AND state IN('pending','running') AND job_id<>?) THEN 'deleting' ELSE 'ready' END,write_version=write_version+1,updated_at=? WHERE user_id=?").bind(user, job.job_id, Date.now(), user), endGuard(db, user, op),
    ]);
    return true;
}
