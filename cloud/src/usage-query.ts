import { FormatRegistry } from '@sinclair/typebox';
import { DateTime } from 'luxon';
import { Value } from '@sinclair/typebox/value';
import { FilterSchema, SettingsSchema, type Settings, type Filter, type Status, type ApiResponse } from '../../shared/contracts';
import { QueryEngine, queryStore, type Statement } from '../../shared/query-engine';
import { officialPrices, pricingInfo } from '../../shared/pricing';
import type { CloudAccountSnapshot, CloudAccountView, CloudHistorySource } from '../../shared/usage-sync';
import { sessionUser } from './auth';
import { fail, json, readJson, requireJson, requireSameOrigin } from './http';
import { assertLegacyRead } from './v3/legacy-read';

FormatRegistry.Set('date-time', v => /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)));
const defaults: Settings = {localInterval:0,accountInterval:0,timezone:'America/New_York',timezoneMode:'manual',costEnabled:false,officialApiPricing:false,modelPrices:officialPrices};
const tokenColumns=new Set(['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens','uncached_input','ordinary_input','paired_input','paired_cached']);
// D1 returns INTEGER through JS Number. Cast sums before transport, then reconstruct BigInt.
function exactSums(sql:string):string {
  let out='',pos=0;
  for(;;){const start=sql.indexOf('SUM(',pos);if(start<0)break;let end=start+4,depth=1;
    while(end<sql.length&&depth){if(sql[end]==='(')depth++;if(sql[end]===')')depth--;end++;}
    out+=sql.slice(pos,start)+'CAST('+sql.slice(start,end)+' AS TEXT)';pos=end;}
  return (out+sql.slice(pos)).replaceAll('AS total_tokens','AS exact_total_tokens').replaceAll('ORDER BY total_tokens DESC','ORDER BY CAST(exact_total_tokens AS INTEGER) DESC');
}
export function scopeSql() {
  return `WITH selected AS (SELECT value id FROM json_each(?)),
    revisions AS (SELECT r.* FROM usage_revisions r JOIN usage_heads h USING(device_id,dataset_id,thread_id,revision)
      WHERE r.user_id=? AND (?=0 OR r.device_id IN (SELECT id FROM selected))),
    candidates AS (SELECT e.*,r.parser_version,r.collected_at FROM usage_records e JOIN revisions r USING(device_id,dataset_id,thread_id,revision)),
    ranked AS (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY event_key ORDER BY parser_version DESC,incomplete,collected_at DESC,device_id,dataset_id) position
      FROM candidates e WHERE kind='record' OR turn_id IS NULL OR NOT EXISTS(SELECT 1 FROM candidates r WHERE r.kind='record' AND r.thread_id=e.thread_id AND r.turn_id=e.turn_id)),
    effective_events AS (SELECT *,NULL service_tier,NULL service_tier_source FROM ranked WHERE position=1),
    thread_rank AS (SELECT r.*,ROW_NUMBER() OVER(PARTITION BY thread_id ORDER BY parser_version DESC,
      COALESCE(json_extract(manifest,'$.thread.titleUpdatedAt'),collected_at) DESC,device_id,dataset_id) position FROM revisions r),
    threads AS (SELECT thread_id id,json_extract(manifest,'$.thread.title') title,json_extract(manifest,'$.thread.project') project,
      json_extract(manifest,'$.thread.source') source,json_extract(manifest,'$.thread.parentId') parent_id,
      json_extract(manifest,'$.thread.subagentParentId') subagent_parent_id,json_extract(manifest,'$.thread.forkedFromId') forked_from_id
      FROM thread_rank WHERE position=1)`;
}
export async function executeQuery<T>(env:Env,userId:string,deviceIds:string[],settings:Settings,query:Generator<Statement,T,any>,filter:Filter={}):Promise<T> {
  const scope=scopeSql(),base=[JSON.stringify(deviceIds),userId,deviceIds.length];
  let next=query.next();
  while(!next.done){
    let {sql}=next.value;const params=[...next.value.params];let prefix=scope,prefixArgs:unknown[]=[...base];
    const bucket=/local_bucket\(at,\?,\?\)/.exec(sql);
    if(bucket){
      const offset=(sql.slice(0,bucket.index).match(/\?/g)||[]).length;
      const [zone,unit]=params.splice(offset,2).map(String);
      const bounds=filter.from&&filter.to?{lo:filter.from,hi:filter.to}:await env.DB.prepare(scope+' SELECT MIN(at) lo,MAX(at) hi FROM effective_events').bind(...base).first<{lo:string|null;hi:string|null}>();
      const lo=bounds?.lo||new Date().toISOString(),hi=bounds?.hi||lo;
      let at=DateTime.fromISO(lo,{zone}).startOf(unit==='hour'?'hour':'day');const stop=Date.parse(hi),buckets:{s:string;e:string;label:string}[]=[];
      while(at.toMillis()<=stop){const end=at.plus(unit==='hour'?{hours:1}:{days:1});buckets.push({s:at.toUTC().toISO()!,e:end.toUTC().toISO()!,label:unit==='hour'?at.toISO()!:at.toISODate()!});at=end;
        if(buckets.length>20000)return fail(400,'RANGE_TOO_WIDE','请缩小小时趋势范围或按日查看。');}
      prefix+=`, time_buckets AS (SELECT json_extract(value,'$.s') s,json_extract(value,'$.e') e,json_extract(value,'$.label') label FROM json_each(?))`;
      prefixArgs.push(JSON.stringify(buckets));sql=sql.replace(bucket[0],'(SELECT label FROM time_buckets WHERE at>=s AND at<e)');
    }
    // Recursive queries can share the same WITH scope.
    const combined=sql.startsWith('WITH RECURSIVE ')?prefix.replace('WITH ','WITH RECURSIVE ')+','+sql.slice(15):prefix+' '+sql;
    // QueryEngine now proves integer safety and emits exact casts itself; rewriting SUM would
    // change numeric ORDER BY expressions into text ordering and invalidate that proof.
    const {results}=await env.DB.prepare(combined).bind(...prefixArgs,...params.map(v=>typeof v==='bigint'?v.toString():v)).all<Record<string,any>>();
    for(const row of results){if(Object.hasOwn(row,'exact_total_tokens')){row.total_tokens=row.exact_total_tokens;delete row.exact_total_tokens;}}
    for(const row of results)for(const key of tokenColumns)if(typeof row[key]==='string')row[key]=BigInt(row[key]);
    next=query.next(next.value.one?results[0]:results);
  }
  return next.value;
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
  // v1 collectors have no user-wide identity; keep their snapshots explicitly device-scoped.
  const legacy=await env.DB.prepare(`SELECT q.*,d.name,d.revoked_at FROM quota_snapshots q JOIN devices d ON d.id=q.device_id
    WHERE q.user_id=? AND NOT EXISTS(SELECT 1 FROM cloud_accounts a WHERE a.device_id=q.device_id)
    AND (?=0 OR q.device_id IN (SELECT value FROM json_each(?)))`).bind(userId,deviceIds.length,JSON.stringify(deviceIds)).all<Record<string,any>>();
  for(const r of legacy.results){const q=JSON.parse(r.payload);grouped.set('legacy:'+r.device_id,{accountRef:'legacy:'+r.device_id,deviceId:r.device_id,deviceName:r.name,receivedAt:new Date(r.received_at).toISOString(),stale:true,quota:q,history:null,historyCollectedAt:null});}
  return [...grouped.values()];
}
export async function usageQueryRoute(request:Request,env:Env,pathname:string):Promise<Response|null> {
  if(!pathname.startsWith('/api/v2/usage/')&&pathname!=='/api/v2/accounts')return null;
  if(new URL(request.url).searchParams.get('legacy_fallback')==='1'){
    if(request.method!=='GET')return fail(405,'READ_ONLY','迁移期间的旧版历史仅供读取。');
    const user=await sessionUser(request,env);
    const version=await assertLegacyRead(env.DB,user.id);
    let response:Response|null;
    try{response=await legacyUsageQueryRoute(request,env,pathname);}
    catch(error){
      // A head change may invalidate integer-safety proofs and make a later SUM
      // fail. Classify that race as an expired read so the caller can retry it.
      await assertLegacyRead(env.DB,user.id,version);throw error;
    }
    // The legacy-head triggers advance write_version for inserts and revisions.
    // Reject count/page, cost/total or proof/SUM results spanning those versions.
    await assertLegacyRead(env.DB,user.id,version);
    if(!response?.ok)return response;
    const body=await response.json<Record<string,any>>();
    return json({...body,meta:{...body.meta,legacyView:{complete:true,user_id:user.id}}});
  }
  return legacyUsageQueryRoute(request,env,pathname);
}
async function legacyUsageQueryRoute(request:Request,env:Env,pathname:string):Promise<Response|null> {
  const user=await sessionUser(request,env), url=new URL(request.url), deviceIds=[...new Set(url.searchParams.getAll('deviceIds'))];
  if(deviceIds.length>100||deviceIds.some(x=>!x||x.length>256))return fail(400,'INVALID_FILTER','设备筛选无效。');
  if(deviceIds.length){const {results}=await env.DB.prepare('SELECT id FROM devices WHERE user_id=? AND id IN (SELECT value FROM json_each(?))').bind(user.id,JSON.stringify(deviceIds)).all();
    if(results.length!==deviceIds.length)return fail(404,'NOT_FOUND','所选设备不存在。');}
  if(pathname==='/api/v2/accounts'&&request.method==='GET')return json({accounts:await accountViews(env,user.id,deviceIds)});
  const row=await env.DB.prepare('SELECT settings FROM users WHERE id=?').bind(user.id).first<{settings:string|null}>();
  let settings:Settings={...defaults,...(row?.settings?JSON.parse(row.settings):{})};
  const route=pathname.slice('/api/v2/usage/'.length);
  const latest=await env.DB.prepare('SELECT MAX(received_at) at FROM devices WHERE user_id=? AND (?=0 OR id IN (SELECT value FROM json_each(?)))').bind(user.id,deviceIds.length,JSON.stringify(deviceIds)).first<{at:number|null}>();
  const updatedAt=latest?.at?new Date(latest.at).toISOString():null;
  const wrap=<T>(data:T,source='cloud'):ApiResponse<T>=>({data,meta:{source,updatedAt,timezone:settings.timezone,warnings:[]}});
  if(route==='settings'){
    if(request.method==='PATCH'){requireSameOrigin(request,env);requireJson(request);const body=await readJson(request,65536);
      if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'INVALID_SETTINGS','设置无效。');
      const next={...settings,...body,localInterval:0,accountInterval:0};
      if(!Value.Check(SettingsSchema,next)||!DateTime.now().setZone(next.timezone).isValid||new Set(next.modelPrices?.map(p=>p.model)).size!==(next.modelPrices?.length||0))return fail(400,'INVALID_SETTINGS','设置无效。');
      await env.DB.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(next),user.id).run();settings=next;
    }else if(request.method!=='GET')return fail(405,'METHOD_NOT_ALLOWED','不支持此操作。');
    return json(wrap(settings,'settings'));
  }
  if(request.method!=='GET')return fail(405,'READ_ONLY','云端只读取已同步统计。');
  if(route==='pricing')return json(wrap(pricingInfo(),'settings'));
  if(route==='capabilities')return json(wrap({mode:'cloud',deviceFilter:true,localControl:false,refresh:'read'}));
  const p=Object.fromEntries(url.searchParams),f:Filter={};
  for(const key of ['from','to','project','model','effort','threadId','unknown'] as const)if(p[key]!==undefined)(f as any)[key]=p[key];
  if(url.searchParams.has('unknowns'))f.unknowns=url.searchParams.getAll('unknowns') as Filter['unknowns'];
  if(!Value.Check(FilterSchema,f)||[f.from,f.to].some(v=>v&&!Number.isFinite(Date.parse(v)))||f.from&&f.to&&Date.parse(f.from)>=Date.parse(f.to)||[...(f.unknown?[f.unknown]:[]),...(f.unknowns||[])].some(k=>(f as any)[k]!==undefined))return fail(400,'INVALID_FILTER','筛选范围无效。');
  const limit=Number(p.limit??50),offset=Number(p.offset??0);
  if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)return fail(400,'INVALID_FILTER','分页参数无效。');
  const engine=new QueryEngine(queryStore(settings));
  const run=<T>(g:Generator<Statement,T,any>)=>executeQuery(env,user.id,deviceIds,settings,g,f);
  if(route==='status'){
    const summary=await run(engine.summary());
    const base={running:false,startedAt:updatedAt,updatedAt,error:null,filesScanned:0,filesChanged:0,events:summary.eventCount,issues:summary.incompleteEvents};
    const account={...base,provider:null,fallbackReason:null,errorCode:null,accountId:null,identityKey:null,identityConfirmed:false,available:false,stale:true};
    const status:Status={local:base,account:base,accountLimits:account,accountHistory:account};return json(wrap(status));
  }
  let result:unknown;
  if(route==='local/summary')result=await run(engine.summary(f));
  else if(route==='local/filters')result=await run(engine.filters(f));
  else if(route==='local/trend')result=await run(engine.trend(f,p.bucket==='hour'?'hour':'day'));
  else if(route==='local/breakdown'){
    if(!['project','model','effort'].includes(p.groupBy))return fail(400,'INVALID_FILTER','分组无效。');
    result=await run(engine.breakdown(f,p.groupBy as 'project'|'model'|'effort',limit,offset));
  }else if(route==='local/threads'){
    const cache=p.cacheBelow===undefined?undefined:Number(p.cacheBelow);if(cache!==undefined&&(!Number.isFinite(cache)||cache<0||cache>1))return fail(400,'INVALID_FILTER','缓存比例无效。');
    result=await run(engine.threads(f,limit,offset,p.sort,cache,p.q));
  }else if(route==='local/turns')result=await run(engine.allTurns({...f,turnId:p.missingTurn==='true'?null:p.turnId},limit,offset,p.sort,p.q));
  else if(route==='local/compare'){
    const group=p.groupBy||'project';if(!['project','model','effort','thread'].includes(group)||!!p.baselineFrom!==!!p.baselineTo||p.baselineFrom&&!(Date.parse(p.baselineFrom)<Date.parse(p.baselineTo)))return fail(400,'INVALID_FILTER','对比范围无效。');
    result=await run(engine.compare(f,group as 'project'|'model'|'effort'|'thread',p.baselineFrom,p.baselineTo));
  }else{
    const match=/^local\/threads\/([^/]+)(?:\/(agents|turns))?$/.exec(route);
    if(!match)return fail(404,'NOT_FOUND','接口不存在。');
    const id=decodeURIComponent(match[1]);result=await (match[2]==='agents'?run(engine.agents(id,f)):match[2]==='turns'?run(engine.turns(id,f,limit,offset,p.sort)):run(engine.detail(id)));
    if(!result)return fail(404,'NOT_FOUND','任务不存在。');
  }
  const thread=/^local\/threads\/([^/]+)/.exec(route)?.[1],threadId=thread?decodeURIComponent(thread):null;
  const scope=scopeSql(),args=[JSON.stringify(deviceIds),user.id,deviceIds.length];
  const sources=await env.DB.prepare(scope+` SELECT d.id,d.name,MIN(c.at) coverageFrom,MAX(c.at) coverageTo,
    d.paused,d.revoked_at,d.initial_complete,d.received_at,d.sync_error FROM revisions r JOIN devices d ON d.id=r.device_id
    LEFT JOIN candidates c USING(device_id,dataset_id,thread_id,revision) WHERE (? IS NULL OR r.thread_id=?) GROUP BY d.id`)
    .bind(...args,threadId,threadId).all<Record<string,any>>();
  const conflicts=await env.DB.prepare(scope+` SELECT COUNT(*) n FROM (SELECT event_key FROM candidates WHERE (? IS NULL OR thread_id=?) GROUP BY event_key
    HAVING COUNT(DISTINCT json_array(thread_id,turn_id,response_id,at,project,model,effort,kind,incomplete,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens))>1)`)
    .bind(...args,threadId,threadId).first<{n:number}>();
  const response=wrap(result);response.meta.devices=sources.results.map(d=>({id:d.id,name:d.name,coverageFrom:d.coverageFrom,coverageTo:d.coverageTo}));response.meta.conflictCount=conflicts?.n||0;
  if(response.meta.conflictCount)response.meta.warnings.push(`${response.meta.conflictCount} 个事件在设备间存在版本差异，已按解析版本、完整度、采集时间和设备标识选择。`);
  if(sources.results.some(d=>!d.initial_complete))response.meta.warnings.push('部分设备的首次历史同步尚未完成，当前仅统计已经完整接收的会话。');
  if(sources.results.some(d=>d.paused||d.revoked_at!==null||d.sync_error||Date.now()-d.received_at>180000))response.meta.warnings.push('部分设备已离线、暂停或撤销；此处保留其最后完整数据。');
  return json(response);
}
