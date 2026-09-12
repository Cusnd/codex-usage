import { type CloudAccountSnapshot, type CloudAccountView, type CloudHistorySource } from "../../contracts/cloud-accounts.js";

export const iso = (n: number | null) => n === null ? null : new Date(n).toISOString();

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
