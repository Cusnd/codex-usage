import { Value } from '@sinclair/typebox/value';
import { AccountUsageSchema } from '../../shared/contracts';
import { isCloudSnapshot } from '../../shared/cloud';
import { ACCOUNT_BODY_BYTES, type CloudAccountSnapshot, type CloudAccountView, type CloudHistorySource } from '../../shared/cloud-accounts';
import { deviceAuth } from './devices';
import { exactObject, fail, json, readJson, requireJson, sha256, token } from './http';
const iso = (n:number|null) => n===null?null:new Date(n).toISOString();
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
export async function accountViews(env:Env,userId:string,deviceIds:string[]):Promise<CloudAccountView[]> {
  const {results}=await env.DB.prepare(`SELECT a.*,d.name,d.paused,d.revoked_at FROM cloud_accounts a JOIN devices d ON d.id=a.device_id
    WHERE a.user_id=? AND a.account_ref=d.current_account_ref AND (?=0 OR a.device_id IN (SELECT value FROM json_each(?)))
    ORDER BY a.received_at DESC,a.device_id`).bind(userId,deviceIds.length,JSON.stringify(deviceIds)).all<Record<string,any>>();
  const grouped=new Map<string,CloudAccountView>();
  const histories=new Map<string,{history:NonNullable<CloudAccountSnapshot['history']>;source:CloudHistorySource}[]>();
  for(const row of results){const p=JSON.parse(row.payload) as CloudAccountSnapshot;
    const view:CloudAccountView={accountRef:row.account_ref,deviceId:row.device_id,deviceName:row.name,receivedAt:new Date(row.received_at).toISOString(),
      stale:!!row.paused||row.revoked_at!==null||p.quota.status!=='ok'||Date.now()-row.received_at>Math.max(180000,p.quota.refreshInterval*2000),
      quota:p.quota,history:p.history,historyCollectedAt:p.historyCollectedAt};
    const key=row.account_ref==='unknown'?'unknown:'+row.device_id:row.account_ref;view.accountRef=key;
    const old=grouped.get(key);
    const chosen=!old || (old.stale&&!view.stale) || old.stale===view.stale&&(p.quota.collectedAt||'')>(old.quota.collectedAt||'')?view:old;
    if(p.history){
      const source:CloudHistorySource={deviceId:row.device_id,deviceName:row.name,collectedAt:p.historyCollectedAt,receivedAt:view.receivedAt,
        stale:!!row.paused||row.revoked_at!==null||!p.historyCollectedAt||Date.now()-Math.min(Date.parse(p.historyCollectedAt),row.received_at)>Math.max(180000,p.quota.refreshInterval*2000)};
      const candidates=histories.get(key)||[];candidates.push({history:p.history,source});histories.set(key,candidates);
    }
    grouped.set(key,chosen);
  }
  for(const [key,candidates] of histories){
    // Select history independently of quota. Resolve every overlapping day against the
    // original snapshots, so an intermediate merged view cannot overwrite a newer day.
    candidates.sort((a,b)=>Date.parse(b.source.collectedAt||'1970-01-01')-Date.parse(a.source.collectedAt||'1970-01-01')||b.source.receivedAt.localeCompare(a.source.receivedAt)||a.source.deviceId.localeCompare(b.source.deviceId));
    const newest=candidates[0],days=new Map<string,NonNullable<NonNullable<CloudAccountSnapshot['history']>['dailyUsageBuckets']>[number]>();
    const dailySources:NonNullable<CloudAccountView['historyMeta']>['dailySources']=[];
    for(const candidate of candidates){const dates:string[]=[];for(const bucket of candidate.history.dailyUsageBuckets||[]){if(!days.has(bucket.startDate)){days.set(bucket.startDate,bucket);dates.push(bucket.startDate);}}
      if(dates.length)dailySources.push({...candidate.source,dates:dates.sort()});}
    const chosen=grouped.get(key)!;chosen.history={...newest.history,dailyUsageBuckets:[...days.values()].sort((a,b)=>a.startDate.localeCompare(b.startDate))};chosen.historyCollectedAt=newest.source.collectedAt;
    chosen.historyMeta={summarySource:newest.source,dailySources};
  }
  return [...grouped.values()];
}
