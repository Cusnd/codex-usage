import { Value } from '@sinclair/typebox/value';
import { AccountUsageSchema } from '../../shared/contracts';
import { isCloudSnapshot } from '../../shared/cloud';
import { SYNC_BODY_BYTES, SyncManifestSchema, validChunk, type CloudAccountSnapshot, type SyncManifest } from '../../shared/usage-sync';
import { deviceAuth } from './devices';
import { sessionUser } from './auth';
import { exactObject, fail, json, readJson, requireJson, requireSameOrigin, sha256, token } from './http';

const iso = (n: number | null) => n === null ? null : new Date(n).toISOString();
export async function cleanupUsage(env:Env,deviceId:string|null=null) {
  // Detach visibility synchronously; reclaim storage in bounded batches, including superseded revisions.
  for(const table of ['usage_records','usage_chunks','usage_revisions']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT e.rowid FROM ${table} e
      JOIN devices d ON d.id=e.device_id LEFT JOIN usage_heads h USING(device_id,dataset_id,thread_id)
      JOIN usage_revisions r ON r.device_id=e.device_id AND r.dataset_id=e.dataset_id AND r.thread_id=e.thread_id AND r.revision=e.revision
      WHERE (? IS NULL OR e.device_id=?) AND (d.history_deleted_at IS NOT NULL OR e.revision<h.revision OR (r.committed=0 AND r.received_at<?))
      ${table==='usage_revisions'?`AND NOT EXISTS(SELECT 1 FROM usage_records c WHERE c.device_id=e.device_id AND c.dataset_id=e.dataset_id AND c.thread_id=e.thread_id AND c.revision=e.revision)
      AND NOT EXISTS(SELECT 1 FROM usage_chunks c WHERE c.device_id=e.device_id AND c.dataset_id=e.dataset_id AND c.thread_id=e.thread_id AND c.revision=e.revision)`:''} LIMIT 1000)`)
      .bind(deviceId,deviceId,Date.now()-86400000).run();
  }
}
export async function usageSyncRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/api/v2/devices' && request.method === 'GET') {
    const user = await sessionUser(request, env);
    const { results } = await env.DB.prepare(`SELECT d.*,q.payload legacy_payload,q.received_at legacy_received_at,
      (SELECT COUNT(*) FROM usage_heads h WHERE h.device_id=d.id) synced_threads,
      (SELECT MIN(e.at) FROM usage_records e JOIN usage_heads h USING(device_id,dataset_id,thread_id,revision) WHERE e.device_id=d.id) coverage_from,
      (SELECT MAX(e.at) FROM usage_records e JOIN usage_heads h USING(device_id,dataset_id,thread_id,revision) WHERE e.device_id=d.id) coverage_to
      FROM devices d LEFT JOIN quota_snapshots q ON q.device_id=d.id AND q.user_id=d.user_id WHERE d.user_id=? ORDER BY d.bound_at,d.id`).bind(user.id).all<Record<string, any>>();
    return json({ devices: results.map(d => ({ id:d.id,name:d.name,boundAt:iso(d.bound_at),protocol:d.protocol,
      paused:!!d.paused,revoked:d.revoked_at !== null,historyDeleted:d.history_deleted_at!==null,collectedAt:d.collected_at||(d.legacy_payload?JSON.parse(d.legacy_payload).collectedAt:null),receivedAt:iso(d.received_at??d.legacy_received_at??null),
      coverageFrom:d.coverage_from,coverageTo:d.coverage_to,syncedThreads:d.synced_threads,totalThreads:d.total_threads,
      initialComplete:!!d.initial_complete,error:d.sync_error })) });
  }
  const deviceMatch = /^\/api\/v2\/devices\/([^/]+)(?:\/(history))?$/.exec(pathname);
  if (deviceMatch && ['PATCH','DELETE'].includes(request.method)) {
    requireSameOrigin(request,env);
    const user = await sessionUser(request,env), id = decodeURIComponent(deviceMatch[1]);
    const device = await env.DB.prepare('SELECT id FROM devices WHERE id=? AND user_id=?').bind(id,user.id).first();
    if (!device) return fail(404,'NOT_FOUND','设备不存在。');
    if (request.method === 'PATCH' && !deviceMatch[2]) {
      requireJson(request); const body = await readJson(request,1024); exactObject(body,['paused']);
      if (typeof body.paused !== 'boolean') return fail(400,'INVALID_INPUT','暂停状态无效。');
      await env.DB.prepare('UPDATE devices SET paused=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(body.paused?1:0,id,user.id).run();
    } else if (deviceMatch[2]) {
      // Revoking first prevents an in-flight collector from recreating deleted history.
      await env.DB.batch([
        env.DB.prepare('UPDATE devices SET revoked_at=?,history_deleted_at=?,initial_complete=0 WHERE id=? AND user_id=?').bind(Date.now(),Date.now(),id,user.id),
        env.DB.prepare('DELETE FROM usage_heads WHERE device_id=?').bind(id),
        env.DB.prepare('DELETE FROM cloud_accounts WHERE device_id=?').bind(id),
        env.DB.prepare('DELETE FROM quota_snapshots WHERE device_id=? AND user_id=?').bind(id,user.id),
      ]);
      // Remove in bounded batches; queries no longer expose the detached revisions.
      await cleanupUsage(env,id);
    } else await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND user_id=?').bind(Date.now(),id,user.id).run();
    return json({ok:true});
  }
  if (!pathname.startsWith('/api/v2/sync/')) return null;
  const device = await deviceAuth(request,env);
  if (pathname === '/api/v2/sync/config' && request.method === 'GET') {
    await env.DB.prepare('UPDATE users SET account_key=? WHERE id=? AND account_key IS NULL').bind(token(),device.user_id).run();
    const user = await env.DB.prepare('SELECT account_key FROM users WHERE id=?').bind(device.user_id).first<{account_key:string}>();
    return json({accountKey:user!.account_key,paused:!!device.paused,deviceId:device.id});
  }
  if (pathname === '/api/v2/sync/pause' && request.method === 'PUT') {
    requireJson(request);const body=await readJson(request,1024);exactObject(body,['paused']);
    if(typeof body.paused!=='boolean')return fail(400,'INVALID_INPUT','暂停状态无效。');
    await env.DB.prepare('UPDATE devices SET paused=? WHERE id=? AND revoked_at IS NULL').bind(body.paused?1:0,device.id).run();return json({ok:true});
  }
  if (device.paused) return fail(423,'DEVICE_PAUSED','设备同步已在云端暂停。');
  requireJson(request);
  if (pathname === '/api/v2/sync/status' && request.method === 'PUT') {
    const body=await readJson(request,2048); exactObject(body,['collectedAt','totalThreads','initialComplete','error']);
    if (!(body.collectedAt===null || typeof body.collectedAt==='string' && Number.isFinite(Date.parse(body.collectedAt))) ||
      !Number.isSafeInteger(body.totalThreads) || Number(body.totalThreads)<0 || typeof body.initialComplete!=='boolean' ||
      ![null,'COLLECTION_FAILED','SYNC_FAILED'].includes(body.error as string|null)) return fail(400,'INVALID_INPUT','同步状态无效。');
    await env.DB.prepare(`UPDATE devices SET protocol=MAX(protocol,2),collected_at=?,received_at=?,total_threads=?,initial_complete=?,sync_error=?
      WHERE id=? AND revoked_at IS NULL AND paused=0`).bind(body.collectedAt,Date.now(),body.totalThreads,body.initialComplete?1:0,body.error,device.id).run();
    return json({ok:true});
  }
  if (pathname === '/api/v2/sync/accounts' && request.method === 'PUT') {
    const body=await readJson(request,SYNC_BODY_BYTES); exactObject(body,['schemaVersion','quota','history','historyCollectedAt']);
    if (body.schemaVersion!==2 || !isCloudSnapshot(body.quota) || body.quota.deviceId!==device.id)
      return fail(400,'INVALID_SNAPSHOT','账户快照无效。');
    const payload=body as unknown as CloudAccountSnapshot, q=payload.quota;
    if (payload.history!==null) {
      exactObject(payload.history,['summary','dailyUsageBuckets']);
      exactObject(payload.history.summary,['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays']);
      if (!Value.Check(AccountUsageSchema,{...payload.history,accountId:null}) || !q.accountRef ||
        !payload.historyCollectedAt || !Number.isFinite(Date.parse(payload.historyCollectedAt))) return fail(400,'INVALID_SNAPSHOT','账户历史无效。');
      if (payload.history.dailyUsageBuckets?.some(b=>Object.keys(b).sort().join(',')!=='startDate,tokens')) return fail(400,'INVALID_SNAPSHOT','账户历史字段无效。');
    } else if (payload.historyCollectedAt!==null) return fail(400,'INVALID_SNAPSHOT','账户历史时间无效。');
    const ref=q.accountRef || 'unknown', requestHash=await sha256(JSON.stringify(payload)), now=Date.now();
    const existing=await env.DB.prepare('SELECT sequence,payload,request_hash FROM cloud_accounts WHERE device_id=? AND account_ref=?').bind(device.id,ref).first<{sequence:number;payload:string;request_hash:string}>();
    if (existing && existing.sequence>=q.sequence) {
      if(existing.sequence===q.sequence&&existing.request_hash===requestHash)return json({acceptedSequence:q.sequence});
      return json({error:{code:'STALE_SEQUENCE',message:'已有更新账户快照。'},acceptedSequence:existing.sequence},409);
    }
    const latest=await env.DB.prepare('SELECT MAX(sequence) sequence FROM cloud_accounts WHERE device_id=?').bind(device.id).first<{sequence:number|null}>();
    if(latest?.sequence!==null&&latest?.sequence!==undefined&&latest.sequence>=q.sequence)return json({error:{code:'STALE_SEQUENCE',message:'已有更新账户选择。'},acceptedSequence:latest.sequence},409);
    if(existing && q.accountRef){
      const previous=JSON.parse(existing.payload) as CloudAccountSnapshot;
      if(q.status!=='ok' && previous.quota.buckets.length){q.buckets=previous.quota.buckets;q.collectedAt=previous.quota.collectedAt;}
      if(previous.history){
        if(payload.history){const days=new Map(previous.history.dailyUsageBuckets?.map(b=>[b.startDate,b])||[]);payload.history.dailyUsageBuckets?.forEach(b=>days.set(b.startDate,b));payload.history.dailyUsageBuckets=[...days.values()].sort((a,b)=>a.startDate.localeCompare(b.startDate));}
        else {payload.history=previous.history;payload.historyCollectedAt=previous.historyCollectedAt;}
      }
    }
    const raw=JSON.stringify(payload),nonce=crypto.randomUUID();
    const r=await env.DB.batch([
      env.DB.prepare(`UPDATE devices SET next_upload_at=?,upload_nonce=?,current_account_ref=? WHERE id=? AND token_hash=? AND revoked_at IS NULL AND paused=0 AND next_upload_at<=?
        AND NOT EXISTS(SELECT 1 FROM cloud_accounts WHERE device_id=? AND sequence>=?)`).bind(now+60000,nonce,ref,device.id,device.token_hash,now,device.id,q.sequence),
      env.DB.prepare(`INSERT INTO cloud_accounts(user_id,device_id,account_ref,sequence,payload,received_at,request_hash)
        SELECT user_id,id,?,?,?,?,? FROM devices WHERE id=? AND upload_nonce=?
        ON CONFLICT(device_id,account_ref) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload,received_at=excluded.received_at,request_hash=excluded.request_hash`).bind(ref,q.sequence,raw,now,requestHash,device.id,nonce),
    ]);
    if(!r[0].meta.changes)return json({error:{code:'SYNC_RATE_LIMITED',message:'额度稍后更新。'}},429,{'Retry-After':'60'});
    return json({acceptedSequence:q.sequence,receivedAt:iso(now)});
  }
  if (pathname === '/api/v2/sync/chunks' && request.method === 'PUT') {
    const body=await readJson(request,SYNC_BODY_BYTES);
    if(!validChunk(body))return fail(400,'INVALID_CHUNK','统计分块无效。');
    const m=body.manifest, raw=JSON.stringify(m), events=JSON.stringify(body.events), hash=await sha256(events);
    const keys=[device.id,m.datasetId,m.thread.id,m.revision];
    const head=await env.DB.prepare('SELECT revision FROM usage_heads WHERE device_id=? AND dataset_id=? AND thread_id=?').bind(...keys.slice(0,3)).first<{revision:number}>();
    if(head&&head.revision>m.revision)return json({error:{code:'STALE_SEQUENCE',message:'已有更新会话。'},acceptedSequence:head.revision},409);
    const fields=['event_key','thread_id','turn_id','response_id','at','project','model','effort','kind','incomplete','input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO usage_revisions(user_id,device_id,dataset_id,thread_id,revision,parser_version,collected_at,manifest,received_at)
        SELECT user_id,id,?,?,?,?,?,?,? FROM devices WHERE id=? AND token_hash=? AND revoked_at IS NULL AND paused=0
        ON CONFLICT(device_id,dataset_id,thread_id,revision) DO NOTHING`).bind(m.datasetId,m.thread.id,m.revision,m.parserVersion,m.collectedAt,raw,Date.now(),device.id,device.token_hash),
      env.DB.prepare(`INSERT INTO usage_chunks(device_id,dataset_id,thread_id,revision,chunk_index,hash,event_count)
        SELECT device_id,dataset_id,thread_id,revision,?,?,? FROM usage_revisions WHERE device_id=? AND dataset_id=? AND thread_id=? AND revision=? AND manifest=?
        AND EXISTS(SELECT 1 FROM devices WHERE id=usage_revisions.device_id AND revoked_at IS NULL AND paused=0)
        ON CONFLICT(device_id,dataset_id,thread_id,revision,chunk_index) DO NOTHING`).bind(body.index,hash,body.events.length,...keys,raw),
      env.DB.prepare(`INSERT INTO usage_records(user_id,device_id,dataset_id,revision,${fields.join(',')})
        SELECT ?,?,?,?,${fields.map(f=>f.endsWith('_tokens')?`CAST(json_extract(j.value,'$.${f}') AS INTEGER)`:`json_extract(j.value,'$.${f}')`).join(',')}
        FROM json_each(?) j WHERE EXISTS(SELECT 1 FROM usage_chunks c JOIN devices d ON d.id=c.device_id WHERE c.device_id=? AND dataset_id=? AND thread_id=? AND revision=? AND chunk_index=? AND hash=? AND d.revoked_at IS NULL AND d.paused=0)
        ON CONFLICT(device_id,dataset_id,thread_id,revision,event_key) DO NOTHING`).bind(device.user_id,device.id,m.datasetId,m.revision,events,...keys,body.index,hash),
    ]);
    const saved=await env.DB.prepare(`SELECT r.manifest,c.hash FROM usage_revisions r JOIN usage_chunks c USING(device_id,dataset_id,thread_id,revision)
      WHERE r.device_id=? AND r.dataset_id=? AND r.thread_id=? AND r.revision=? AND c.chunk_index=?`).bind(...keys,body.index).first<{manifest:string;hash:string}>();
    if(!saved||saved.manifest!==raw||saved.hash!==hash)return fail(409,'REVISION_CONFLICT','修订或分块内容冲突，请重新同步。');
    return json({ok:true,index:body.index});
  }
  if(pathname==='/api/v2/sync/commit'&&request.method==='POST') {
    const body=await readJson(request,SYNC_BODY_BYTES);
    if(!Value.Check(SyncManifestSchema,body))return fail(400,'INVALID_MANIFEST','会话清单无效。');
    const m=body as SyncManifest,keys=[device.id,m.datasetId,m.thread.id,m.revision],raw=JSON.stringify(m);
    const {results}=await env.DB.prepare('SELECT hash,event_count FROM usage_chunks WHERE device_id=? AND dataset_id=? AND thread_id=? AND revision=? ORDER BY chunk_index').bind(...keys).all<{hash:string;event_count:number}>();
    const count=await env.DB.prepare('SELECT COUNT(*) n FROM usage_records WHERE device_id=? AND dataset_id=? AND thread_id=? AND revision=?').bind(...keys).first<{n:number}>();
    if(results.length!==m.chunkCount||results.reduce((n,r)=>n+r.event_count,0)!==m.eventCount||count?.n!==m.eventCount||
      await sha256(JSON.stringify(m.thread)+'|'+results.map(r=>r.hash).join('|'))!==m.contentHash)return fail(409,'INCOMPLETE_REVISION','会话尚未完整上传。');
    const r=await env.DB.batch([
      env.DB.prepare(`UPDATE usage_revisions SET committed=1 WHERE device_id=? AND dataset_id=? AND thread_id=? AND revision=? AND manifest=?
        AND EXISTS(SELECT 1 FROM devices WHERE id=? AND token_hash=? AND revoked_at IS NULL AND paused=0)`).bind(...keys,raw,device.id,device.token_hash),
      env.DB.prepare(`INSERT INTO usage_heads(user_id,device_id,dataset_id,thread_id,revision)
        SELECT user_id,device_id,dataset_id,thread_id,revision FROM usage_revisions WHERE device_id=? AND dataset_id=? AND thread_id=? AND revision=? AND manifest=? AND committed=1
        AND EXISTS(SELECT 1 FROM devices WHERE id=? AND token_hash=? AND revoked_at IS NULL AND paused=0)
        ON CONFLICT(device_id,dataset_id,thread_id) DO UPDATE SET revision=excluded.revision WHERE excluded.revision>=usage_heads.revision`).bind(...keys,raw,device.id,device.token_hash),
      env.DB.prepare('UPDATE devices SET protocol=2,collected_at=?,received_at=? WHERE id=? AND revoked_at IS NULL').bind(m.collectedAt,Date.now(),device.id),
    ]);
    if(!r[0].meta.changes)return fail(409,'REVISION_CONFLICT','修订不可提交。');
    return json({ok:true,acceptedSequence:m.revision});
  }
  return fail(404,'NOT_FOUND','同步接口不存在。');
}
