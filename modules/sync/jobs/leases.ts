import { type Job } from "./types.js";

export async function claimJob(db:D1Database,user?:string,id?:string):Promise<Job|null> {
  const now=Date.now(),lease=crypto.randomUUID();
  return db.prepare(`UPDATE v3_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE rowid=(SELECT rowid FROM v3_jobs WHERE state IN('pending','running') AND next_attempt_at<=? AND lease_until<=? AND (? IS NULL OR user_id=?) AND (? IS NULL OR job_id=?) ORDER BY CASE WHEN kind='delete_device' THEN 0 WHEN job_id=(SELECT rebuild_job FROM v3_sync_domains h WHERE h.user_id=v3_jobs.user_id) THEN 1 ELSE 2 END,created_at,job_id LIMIT 1) RETURNING *`).bind(lease,now+30_000,now,now,now,user??null,user??null,id??null,id??null).first<Job>();
}

export async function release(db: D1Database, job: Job, delay = 1000, code: string | null = null) {
    await db.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=?,error_code=?,updated_at=? WHERE user_id=? AND job_id=? AND lease_token=?").bind(Date.now() + delay, code, Date.now(), job.user_id, job.job_id, job.lease_token).run();
}
