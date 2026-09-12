import { domain, endGuard, guard, isCasFailure } from "../publication/store.js";
import { rebuildCleanup } from "../apply/rebuild.js";
import { originFailureStatements } from "./origin-handler.js";
import { type Job } from "./types.js";

export async function failJob(db: D1Database, job: Job, code: string, cancel = false) {
    const h = await domain(db, job.user_id), op = crypto.randomUUID();
    try {
        await db.batch([
            guard(db, h, op, undefined, job),
            db.prepare('UPDATE v3_jobs SET state=?,error_code=?,lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?').bind(cancel ? 'cancelled' : 'failed', code, Date.now(), job.user_id, job.job_id),
            ...['apply', 'rebuild'].includes(job.kind) ? [
                db.prepare('UPDATE v3_receipts SET status=?,error_code=? WHERE user_id=? AND batch_id=?').bind(cancel ? 'cancelled' : 'failed', code, job.user_id, JSON.parse(job.payload).batch_id),
                db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(job.user_id, JSON.parse(job.payload).batch_id),
            ] : [],
            ...job.kind === 'rebuild' ? [
                ...['v3_events', 'v3_entity_versions', 'v3_aggregates', 'v3_aggregate_members'].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=?`).bind(job.user_id, JSON.parse(job.checkpoint).epoch)), ...rebuildCleanup(db, job.user_id, job.job_id),
                db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(job.user_id, job.job_id),
            ] : [], ...job.kind === 'origin_assignment' ? originFailureStatements(db, h, job, code) : [], endGuard(db, job.user_id, op),
        ]);
    }
    catch (error) {
        if (!isCasFailure(error))
            throw error;
    }
}

export async function restartRebuild(db: D1Database, job: Job, delay = 30000, code = 'DEVICE_PAUSED') {
    const h = await domain(db, job.user_id), epoch = JSON.parse(job.checkpoint).epoch, op = crypto.randomUUID();
    await db.batch([guard(db, h, op, undefined, job), ...['v3_events', 'v3_entity_versions', 'v3_aggregates', 'v3_aggregate_members'].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id=? AND epoch=? AND epoch<>?`).bind(job.user_id, epoch, h.active_epoch)), ...rebuildCleanup(db, job.user_id, job.job_id), db.prepare("UPDATE v3_sync_domains SET mode=CASE WHEN mode='rebuilding' THEN 'ready' ELSE mode END,rebuild_job=NULL,write_version=write_version+1 WHERE user_id=? AND rebuild_job=?").bind(job.user_id, job.job_id), db.prepare("UPDATE v3_jobs SET kind='apply',checkpoint='{}',state='pending',lease_token=NULL,lease_until=0,next_attempt_at=?,error_code=? WHERE user_id=? AND job_id=?").bind(Date.now() + delay, code, job.user_id, job.job_id), endGuard(db, job.user_id, op)]);
}

export async function recoverSupersededRebuild(db: D1Database, job: Job) {
    const device = await db.prepare('SELECT revoked_at,history_deleted_at FROM devices WHERE user_id=? AND id=?').bind(job.user_id, job.device_id).first<{
        revoked_at: number | null;
        history_deleted_at: number | null;
    }>();
    if (!device || device.revoked_at !== null || device.history_deleted_at !== null)
        return failJob(db, job, 'DEVICE_REVOKED', true);
    // Another uploader's deletion supersedes this private epoch, not this received input.
    // Preserve its immutable wire and watermark; retry application against the post-delete head.
    return restartRebuild(db, job, 0, 'REBUILD_SUPERSEDED');
}
