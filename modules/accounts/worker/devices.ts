import type { CloudSource } from '../../contracts/cloud-accounts.js';

const iso=(value:number|null|undefined)=>value==null?null:new Date(value).toISOString();
/** Coverage counts describe applied source generations, including sources that produced no usage.
 * syncedThreads counts complete and available latest source generations; retainedThreads counts
 * active cloud history even while a source is unavailable or its replacement is incomplete.
 * totalThreads is only the latest collector report, not a denominator for either count. */
export async function deviceViews(db:D1Database,user:string):Promise<(CloudSource&{historyDeleting:boolean;deletionStatus:'retained'|'deleting'|'deleted'|'failed';appliedAt:string|null;sourceCounts:{known:number;complete:number;unavailable:number;pendingBatches:number}})[]> {
  const rows=(await db.prepare(`SELECT d.*,
    (SELECT MAX(r.received_at) FROM v3_receipts r WHERE r.user_id=d.user_id AND r.device_id=d.id) v3_received,
    (SELECT MAX(r.applied_at) FROM v3_receipts r WHERE r.user_id=d.user_id AND r.device_id=d.id AND r.status='applied') v3_applied,
    (SELECT COUNT(*) FROM v3_receipts r WHERE r.user_id=d.user_id AND r.device_id=d.id AND r.status='received') pending_batches,
    (SELECT COUNT(DISTINCT json_extract(s.context,'$.thread_id')) FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE c.user_id=d.user_id AND c.device_id=d.id AND s.active=1 AND s.kind='session' AND s.complete=1 AND s.available=1 AND NOT EXISTS(SELECT 1 FROM v3_sources n WHERE (n.user_id,n.collector_id,n.source_id)=(s.user_id,s.collector_id,s.source_id) AND n.generation>s.generation)) synced_threads,
    (SELECT COUNT(DISTINCT t.thread_id) FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) JOIN v3_collectors c USING(user_id,collector_id) WHERE c.user_id=d.user_id AND c.device_id=d.id AND s.active=1) retained_threads,
    (SELECT COUNT(*) FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE c.user_id=d.user_id AND c.device_id=d.id AND NOT EXISTS(SELECT 1 FROM v3_sources n WHERE (n.user_id,n.collector_id,n.source_id)=(s.user_id,s.collector_id,s.source_id) AND n.generation>s.generation)) known_sources,
    (SELECT COUNT(*) FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE c.user_id=d.user_id AND c.device_id=d.id AND s.active=1 AND s.complete=1 AND s.available=1 AND NOT EXISTS(SELECT 1 FROM v3_sources n WHERE (n.user_id,n.collector_id,n.source_id)=(s.user_id,s.collector_id,s.source_id) AND n.generation>s.generation)) complete_sources,
    (SELECT COUNT(*) FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE c.user_id=d.user_id AND c.device_id=d.id AND s.available=0 AND NOT EXISTS(SELECT 1 FROM v3_sources n WHERE (n.user_id,n.collector_id,n.source_id)=(s.user_id,s.collector_id,s.source_id) AND n.generation>s.generation)) unavailable_sources,
    (SELECT MIN(c.at) FROM v3_candidates c WHERE c.user_id=d.user_id AND c.uploader_device_id=d.id AND c.active=1) coverage_from,
    (SELECT MAX(c.at) FROM v3_candidates c WHERE c.user_id=d.user_id AND c.uploader_device_id=d.id AND c.active=1) coverage_to,
    (SELECT r.error_code FROM v3_receipts r WHERE r.user_id=d.user_id AND r.device_id=d.id AND r.status='failed' ORDER BY r.received_at DESC LIMIT 1) receipt_error
    ,(SELECT j.state FROM v3_jobs j WHERE j.user_id=d.user_id AND j.job_id='delete:'||d.id) deletion_job_state
    FROM devices d WHERE d.user_id=? ORDER BY d.bound_at,d.id`).bind(user).all<Record<string,any>>()).results;
  return rows.map(d=>{const deletionStatus=d.history_deleted_at===null?'retained':d.deletion_job_state==='failed'||d.deletion_job_state==='cancelled'?'failed':d.deletion_job_state==='pending'||d.deletion_job_state==='running'?'deleting':'deleted';return {id:d.id,name:d.name,boundAt:iso(d.bound_at)!,protocol:d.protocol,paused:!!d.paused,revoked:d.revoked_at!==null,historyDeleted:deletionStatus==='deleted',historyDeleting:deletionStatus==='deleting',deletionStatus,
    collectedAt:d.collected_at,receivedAt:iso(d.v3_received??d.received_at),appliedAt:iso(d.v3_applied),coverageFrom:d.coverage_from,coverageTo:d.coverage_to,syncedThreads:d.synced_threads,retainedThreads:d.retained_threads,totalThreads:d.total_threads,
    initialComplete:!!d.initial_complete&&d.total_threads!==null&&d.synced_threads>=d.total_threads&&d.known_sources===d.complete_sources&&d.pending_batches===0&&d.history_deleted_at===null,error:d.receipt_error||d.sync_error,
    sourceCounts:{known:d.known_sources,complete:d.complete_sources,unavailable:d.unavailable_sources,pendingBatches:d.pending_batches}};});
}
