import { Value } from "@sinclair/typebox/value";
import { AccountUsageSchema } from "../../modules/contracts/accounts.js";
import { isCloudSnapshot } from "../../modules/contracts/cloud.js";
import { ACCOUNT_BODY_BYTES, type CloudAccountSnapshot } from "../../modules/contracts/cloud-accounts.js";
import { deviceAuth } from "./devices.js";
import { exactObject, fail, json, readJson, requireJson, sha256, token } from "../../modules/platform/worker/http.js";
import { iso } from '../../modules/accounts/worker/accounts.js';

export async function accountRoute(request:Request,env:Env,pathname:string):Promise<Response|null> {
  if(!['/api/v3/collector/config','/api/v3/collector/pause','/api/v3/accounts/observations'].includes(pathname))return null;
  const device=await deviceAuth(request,env);
  if (pathname === '/api/v3/collector/config' && request.method === 'GET') {
    await env.DB.prepare('UPDATE users SET account_key=? WHERE id=? AND account_key IS NULL').bind(token(),device.user_id).run();
    const user = await env.DB.prepare('SELECT account_key FROM users WHERE id=?').bind(device.user_id).first<{account_key:string}>();
    return json({accountKey:user!.account_key,paused:!!device.paused,deviceId:device.id});
  }
  if (pathname === '/api/v3/collector/pause' && request.method === 'PUT') {
    requireJson(request);const body=await readJson(request,1024);exactObject(body,['paused']);
    if(typeof body.paused!=='boolean')return fail(400,'INVALID_INPUT','暂停状态无效。');
    await env.DB.prepare('UPDATE devices SET paused=? WHERE id=? AND revoked_at IS NULL').bind(body.paused?1:0,device.id).run();return json({ok:true});
  }
  if(device.paused)return fail(423,'DEVICE_PAUSED','设备同步已在云端暂停。');
  requireJson(request);
  if (pathname === '/api/v3/accounts/observations' && request.method === 'PUT') {
    const body=await readJson(request,ACCOUNT_BODY_BYTES); exactObject(body,['schemaVersion','quota','history','historyCollectedAt']);
    if (body.schemaVersion!==3 || !isCloudSnapshot(body.quota) || body.quota.deviceId!==device.id)
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
  return fail(405,'METHOD_NOT_ALLOWED','不支持该请求方法。');
}
