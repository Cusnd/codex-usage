import { Value } from '@sinclair/typebox/value';
import { FormatRegistry } from '@sinclair/typebox';
import { DateTime } from 'luxon';
import { FilterSchema, SettingsSchema, type Filter, type Settings } from '../../../shared/contracts';
import { QueryEngine, queryStore, type Statement, type QueryFilter } from '../../../shared/query-engine';
import { pricingInfo } from '../../../shared/pricing';
import { stableJson } from '../../../shared/sync-v3';
import { fail } from '../http';
import { createRead, getRead, type ReadLease } from './snapshots';
import { defaultSettings } from './defaults';
import { resolveReadSettings } from './timezone';

export { defaultSettings } from './defaults';
FormatRegistry.Set('date-time', value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
export async function loadSettings(db:D1Database,user:string):Promise<Settings> {
  const row=await db.prepare('SELECT payload FROM v3_settings WHERE user_id=?').bind(user).first<{payload:string|null}>();
  const value={...defaultSettings,...(row?.payload?JSON.parse(row.payload):{})};return value;
}
export function queryScope():string {
  const fields=['turn_id','response_id','source_project_id','model','effort','kind','service_tier','service_tier_source','input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
  // Inline the version predicate so each consumer keeps its kind/thread/time indexes.
  // Join project versions by their published entity key, not a JSON expression.
  // A flattened JSON join can scan all versions once per event; even a materialized
  // project map still needs a linear scan per event when automatic indexes are off.
  const membershipJoin="LEFT JOIN v3_entity_versions p ON p.user_id=v.user_id AND p.epoch=v.epoch AND p.kind='project' AND p.entity_id='source:'||json_extract(v.payload,'$.source_project_id') AND p.valid_from<=l.cut AND (p.valid_to IS NULL OR l.cut<p.valid_to) AND p.payload IS NOT NULL";
  return `WITH lease AS (SELECT l.* FROM v3_read_leases l JOIN v3_sync_domains h ON h.user_id=l.user_id WHERE l.user_id=? AND l.lease_id=? AND l.expires_at>? AND l.deletion_version=h.deletion_version AND h.mode<>'deleting'),
    versions AS NOT MATERIALIZED (SELECT v.* FROM v3_entity_versions v JOIN lease l ON v.user_id=l.user_id AND v.epoch=l.epoch WHERE v.valid_from<=l.cut AND (v.valid_to IS NULL OR l.cut<v.valid_to) AND v.payload IS NOT NULL),
    project_membership AS (SELECT json_extract(payload,'$.id') source_id,json_extract(payload,'$.logical_project_id') logical_id,json_extract(payload,'$.name') source_name,json_extract(payload,'$.root') source_root FROM versions WHERE kind='project' AND json_extract(payload,'$.subtype')='source'),
    project_aliases AS (SELECT json_extract(payload,'$.id') alias,json_extract(payload,'$.target') target FROM versions WHERE kind='project' AND json_extract(payload,'$.subtype')='alias'),
    logical_projects AS (SELECT json_extract(payload,'$.id') id,json_extract(payload,'$.project.name') name FROM versions WHERE kind='project' AND json_extract(payload,'$.subtype')='logical'),
    effective_events AS (SELECT v.entity_id event_key,v.thread_id,v.at,${fields.map(f=>`json_extract(v.payload,'$.${f}') ${f}`).join(',')},json_extract(p.payload,'$.logical_project_id') project,COALESCE(json_extract(v.payload,'$.incomplete'),0) incomplete FROM versions v CROSS JOIN lease l ${membershipJoin} WHERE v.kind='event' AND (json_array_length(l.device_ids)=0 OR v.origin_device_id IN(SELECT value FROM json_each(l.device_ids)))),
    threads AS (SELECT v.entity_id id,json_extract(v.payload,'$.title') title,json_extract(p.payload,'$.logical_project_id') project,json_extract(v.payload,'$.source') source,json_extract(v.payload,'$.parent_id') parent_id,json_extract(v.payload,'$.subagent_parent_id') subagent_parent_id,json_extract(v.payload,'$.forked_from_id') forked_from_id FROM versions v CROSS JOIN lease l ${membershipJoin} WHERE v.kind='thread')`;
}
export async function executeV3Query<T>(db:D1Database,user:string,lease:string,query:Generator<Statement,T,any>):Promise<T> {
  try {
    await getRead(db,user,lease);let step=query.next();
    while(!step.done){const {sql,params,one}=step.value,scope=queryScope(),combined=sql.startsWith('WITH RECURSIVE ')?scope.replace('WITH ','WITH RECURSIVE ')+','+sql.slice(15):sql.startsWith('WITH ')?scope+','+sql.slice(5):scope+' '+sql;
      const rows=await db.prepare(combined).bind(user,lease,Date.now(),...params.map(p=>typeof p==='bigint'?p.toString():p)).all<Record<string,unknown>>();step=query.next(one?rows.results[0]:rows.results);}
    await getRead(db,user,lease);return step.value;
  }catch(error){
    const code=error&&typeof error==='object'&&'code' in error?error.code:null;
    if(code==='INVALID_TOKEN_STORAGE')return fail(409,'INVALID_TOKEN_STORAGE','来源包含无法精确统计的历史数值，请重新采集对应来源。');
    if(code==='RANGE_TOO_WIDE')return fail(400,'RANGE_TOO_WIDE','时间范围过大，请缩小范围或按天查看趋势。');
    throw error;
  }
}
export async function queryUsage(db:D1Database,user:string,url:URL,route:string) {
  let leaseId=url.searchParams.get('lease_id');if(!leaseId)leaseId=(await createRead(db,user,'full',[...new Set(url.searchParams.getAll('deviceIds'))])).lease_id;
  const lease:ReadLease=await getRead(db,user,leaseId),settings=resolveReadSettings(lease.settings,url),p=Object.fromEntries(url.searchParams),f:QueryFilter={};
  for(const key of ['from','to','project','model','effort','threadId','unknown'] as const)if(p[key]!==undefined)(f as Record<string,unknown>)[key]=p[key];
  if(url.searchParams.has('unknowns'))f.unknowns=url.searchParams.getAll('unknowns') as Filter['unknowns'];
  if(!Value.Check(FilterSchema,f)||[f.from,f.to].some(v=>v&&!Number.isFinite(Date.parse(v)))||f.from&&f.to&&Date.parse(f.from)>=Date.parse(f.to)||[...(f.unknown?[f.unknown]:[]),...(f.unknowns||[])].some(k=>(f as any)[k]!==undefined))fail(400,'INVALID_FILTER','筛选范围无效。');
  if(f.project){const project=f.project;const target=await executeV3Query(db,user,leaseId,(function*():Generator<Statement,string|null,any>{const row=yield {sql:'SELECT target FROM project_aliases WHERE alias=?',params:[project],one:true};return row?.target||null;})());if(target)f.project=target;}
  if(p.q?.trim()){const q=p.q.trim();f.qProjects=await executeV3Query(db,user,leaseId,(function*():Generator<Statement,string[],any>{const rows=yield {sql:`SELECT id FROM logical_projects WHERE instr(lower(COALESCE(name,'')),lower(?))>0 UNION SELECT logical_id id FROM project_membership WHERE logical_id IS NOT NULL AND (instr(lower(COALESCE(source_name,'')),lower(?))>0 OR instr(lower(COALESCE(source_root,'')),lower(?))>0)`,params:[q,q,q]};return rows.map((r:{id:string})=>r.id);})());}
  const limit=Number(p.limit??50),offset=Number(p.offset??0);if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)fail(400,'INVALID_FILTER','分页参数无效。');
  const engine=new QueryEngine(queryStore(settings)),run=<T>(g:Generator<Statement,T,any>)=>executeV3Query(db,user,leaseId!,g);
  let data:unknown;
  if(route==='settings')data=settings;
  else if(route==='pricing')data=pricingInfo();
  else if(route==='capabilities')data={mode:'cloud',deviceFilter:true,localControl:false,refresh:'read'};
  else if(route==='local/summary')data=await run(engine.summary(f));
  else if(route==='local/filters')data=await run(engine.filters(f));
  else if(route==='local/trend')data=await run(engine.trend(f,p.bucket==='hour'?'hour':'day'));
  else if(route==='local/breakdown'){if(!['project','model','effort'].includes(p.groupBy))fail(400,'INVALID_FILTER','分组无效。');data=await run(engine.breakdown(f,p.groupBy as 'project'|'model'|'effort',limit,offset));}
  else if(route==='local/threads'){const cache=p.cacheBelow===undefined?undefined:Number(p.cacheBelow);if(cache!==undefined&&(!Number.isFinite(cache)||cache<0||cache>1))fail(400,'INVALID_FILTER','缓存比例无效。');data=await run(engine.threads(f,limit,offset,p.sort,cache,p.q));}
  else if(route==='local/turns')data=await run(engine.allTurns({...f,turnId:p.missingTurn==='true'?null:p.turnId},limit,offset,p.sort,p.q));
  else if(route==='local/compare'){const by=p.groupBy||'project';if(!['project','model','effort','thread'].includes(by)||!!p.baselineFrom!==!!p.baselineTo||p.baselineFrom&&!(Date.parse(p.baselineFrom)<Date.parse(p.baselineTo)))fail(400,'INVALID_FILTER','对比范围无效。');data=await run(engine.compare(f,by as 'project'|'model'|'effort'|'thread',p.baselineFrom,p.baselineTo));}
  else if(route==='status'){const summary=await run(engine.summary()),base={running:false,startedAt:null,updatedAt:null,error:null,filesScanned:0,filesChanged:0,events:summary.eventCount,issues:summary.incompleteEvents},account={...base,provider:null,fallbackReason:null,errorCode:null,accountId:null,identityKey:null,identityConfirmed:false,available:false,stale:true};data={local:base,account:base,accountLimits:account,accountHistory:account};}
  else {const match=/^local\/threads\/([^/]+)(?:\/(agents|turns))?$/.exec(route);if(!match)return fail(404,'NOT_FOUND','接口不存在。');const id=decodeURIComponent(match[1]);data=await(match[2]==='agents'?run(engine.agents(id,f)):match[2]==='turns'?run(engine.turns(id,f,limit,offset,p.sort)):run(engine.detail(id)));if(!data)fail(404,'NOT_FOUND','任务不存在。');}
  if((route==='local/breakdown'||route==='local/compare')&&(p.groupBy||'project')==='project'&&data&&typeof data==='object'&&'items' in data){
    const rows=(data as {items:{key:string|null;label:string}[]}).items,keys=rows.flatMap(r=>r.key===null?[]:[r.key]);
    const names=await executeV3Query(db,user,leaseId,(function*():Generator<Statement,{id:string;name:string|null}[],any>{return yield {sql:'SELECT id,name FROM logical_projects WHERE id IN(SELECT value FROM json_each(?))',params:[stableJson(keys)]};})());
    const byId=new Map(names.map(n=>[n.id,n.name]));for(const row of rows)if(row.key&&byId.get(row.key))row.label=byId.get(row.key)!;
  }
  return {data,meta:{source:'cloud',updatedAt:null,timezone:settings.timezone,warnings:[],lease_id:leaseId,cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version}}};
}
export function validSettings(value:unknown):value is Settings {
  return Value.Check(SettingsSchema,value)&&DateTime.now().setZone(value.timezone).isValid&&new Set(value.modelPrices?.map(p=>p.model)).size===(value.modelPrices?.length||0);
}
