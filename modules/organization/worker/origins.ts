import { stableJson } from "../../contracts/sync.js";
import { fail, sha256 } from "../../platform/worker/http.js";
import { createRead, getRead } from "../../sync/reads/snapshots.js";
import { domain, endGuard, guard, isCasFailure } from "../../sync/publication/store.js";

export type Input = {
    operation_id: string;
    lease_id: string;
    action: 'assign' | 'revoke';
    thread_ids: string[];
    device_id?: string;
};

export type Operation = {
    serial: number;
    operation_id: string;
    request_hash: string;
    action: 'assign' | 'revoke';
    device_id: string | null;
    status: 'pending' | 'complete' | 'failed';
    payload: string;
    affected_events: number;
    result_cut: string | null;
    error_code: string | null;
};

export type Checkpoint = {
    phase: 'select' | 'small' | 'events' | 'metadata' | 'publish';
    epoch: string;
    source_epoch: string;
    source_cut: number;
    last?: string;
    selected: number;
};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const naturalUnknown = (alias: string) => `json_extract(${alias}.payload,'$.origin_device_id') IS NULL AND COALESCE(json_extract(${alias}.payload,'$.origin_conflict'),0)=0`;

const counts=`SUM(CASE WHEN json_extract(v.payload,'$.origin_device_id') IS NULL AND COALESCE(json_extract(v.payload,'$.origin_conflict'),0)=0 AND json_extract(v.payload,'$.user_assignment') IS NULL THEN 1 ELSE 0 END) unknown_events,SUM(CASE WHEN json_extract(v.payload,'$.user_assignment') IS NOT NULL THEN 1 ELSE 0 END) assigned_events,SUM(CASE WHEN json_extract(v.payload,'$.origin_device_id') IS NOT NULL THEN 1 ELSE 0 END) natural_known_events`;

const versionScope=`WITH versions AS(SELECT v.* FROM v3_entity_versions v WHERE v.user_id=? AND v.epoch=? AND v.valid_from<=? AND (v.valid_to IS NULL OR v.valid_to>?) AND v.payload IS NOT NULL)`;

export async function operation(db: D1Database, user: string, id: string): Promise<Operation> { return (await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user, id).first<Operation>()) ?? fail(404, 'NOT_FOUND', '归属操作不存在。'); }

export const result = (o: Operation) => ({ operation_id: o.operation_id, status: o.status, job_id: 'origin:' + o.operation_id, ...o.status === 'complete' ? { affected_events: o.affected_events, cut: JSON.parse(o.result_cut!) } : {}, ...o.status === 'failed' ? { error: { code: o.error_code, message: '归属修改未完成，原有已发布历史保持可用，请重新读取后重试。' } } : {} });

export async function assertTarget(db: D1Database, user: string, id: string) { if (!await db.prepare('SELECT id FROM devices WHERE user_id=? AND id=? AND history_deleted_at IS NULL').bind(user, id).first())
    fail(404, 'NOT_FOUND', '指定设备不存在或其历史已删除。'); }

export async function originView(db:D1Database,user:string,url:URL){
  const id=url.searchParams.get('lease_id')||(await createRead(db,user,'full',[])).lease_id,lease=await getRead(db,user,id),limit=Number(url.searchParams.get('limit')||50),cursor=url.searchParams.get('cursor')||'';
  if(lease.scope!=='full'||JSON.parse(lease.device_ids).length)fail(400,'INVALID_SCOPE','归属管理需要全部设备的完整读取版本。');
  if(!Number.isInteger(limit)||limit<1||limit>200||cursor.length>2048)fail(400,'INVALID_CURSOR','分页参数无效。');
  const args=[user,lease.epoch,lease.cut,lease.cut],summary=await db.prepare(versionScope+` SELECT ${counts} FROM versions v WHERE v.kind='event'`).bind(...args).first<Record<string,number|null>>();
  const rows=(await db.prepare(versionScope+` SELECT v.thread_id id,(SELECT json_extract(t.payload,'$.title') FROM versions t WHERE t.kind='thread' AND t.entity_id=v.thread_id) title,${counts} FROM versions v WHERE v.kind='event' AND v.thread_id>? GROUP BY v.thread_id HAVING unknown_events+assigned_events>0 ORDER BY v.thread_id LIMIT ?`).bind(...args,cursor,limit+1).all()).results;
  await getRead(db,user,id);
  return {lease_id:id,cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version},summary:Object.fromEntries(Object.entries(summary!).map(([k,v])=>[k,v??0])),sessions:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].id:null};
}

export async function start(db: D1Database, user: string, b: Input) {
    if (!b || typeof b !== 'object' || Object.keys(b).some(k => !['operation_id', 'lease_id', 'action', 'thread_ids', 'device_id'].includes(k)) || !uuid.test(b.operation_id) || typeof b.lease_id !== 'string' || b.lease_id.length > 256 || !['assign', 'revoke'].includes(b.action) || !Array.isArray(b.thread_ids) || !b.thread_ids.length || b.thread_ids.length > 200 || b.thread_ids.some(id => typeof id !== 'string' || !id || id.length > 2048) || new Set(b.thread_ids).size !== b.thread_ids.length || b.action === 'assign' && (typeof b.device_id !== 'string' || !b.device_id || b.device_id.length > 256) || b.action === 'revoke' && b.device_id !== undefined)
        fail(400, 'INVALID_INPUT', '归属操作参数无效。');
    b = { ...b, thread_ids: [...b.thread_ids].sort() };
    const hash = await sha256(stableJson(b)), saved = await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user, b.operation_id).first<Operation>();
    if (saved) {
        if (saved.request_hash !== hash)
            fail(409, 'OPERATION_CONFLICT', '同一操作编号已经对应其他内容。');
        return saved;
    }
    const lease = await getRead(db, user, b.lease_id);
    if (lease.scope !== 'full' || JSON.parse(lease.device_ids).length)
        fail(400, 'INVALID_SCOPE', '归属管理需要全部设备的完整读取版本。');
    if (b.action === 'assign')
        await assertTarget(db, user, b.device_id!);
    const h = await domain(db, user);
    if (h.mode !== 'ready')
        fail(409, 'DATASET_UPDATING', '历史正在更新，请稍后重试。');
    const job = 'origin:' + b.operation_id, op = crypto.randomUUID(), now = Date.now(), checkpoint: Checkpoint = { phase: 'select', epoch: crypto.randomUUID(), source_epoch: lease.epoch, source_cut: lease.cut, selected: 0 };
    try {
        await db.batch([guard(db, h, op),
            db.prepare('INSERT INTO v3_origin_operations(user_id,operation_id,request_hash,action,device_id,payload,created_at) VALUES(?,?,?,?,?,?,?)').bind(user, b.operation_id, hash, b.action, b.device_id ?? null, stableJson(b), now),
            db.prepare("INSERT INTO v3_jobs(user_id,job_id,kind,payload,checkpoint,created_at,updated_at) VALUES(?,?,'origin_assignment',?,?,?,?)").bind(user, job, stableJson({ operation_id: b.operation_id }), stableJson(checkpoint), now, now),
            db.prepare("UPDATE v3_sync_domains SET mode='rebuilding',rebuild_job=?,write_version=write_version+1 WHERE user_id=?").bind(job, user), endGuard(db, user, op)]);
    }
    catch (error) {
        const existing = await db.prepare('SELECT * FROM v3_origin_operations WHERE user_id=? AND operation_id=?').bind(user, b.operation_id).first<Operation>();
        if (existing && existing.request_hash === hash)
            return existing;
        if (isCasFailure(error))
            fail(409, 'WRITE_CONFLICT', '历史版本正在变化，请重试同一操作。');
        throw error;
    }
    return operation(db, user, b.operation_id);
}
