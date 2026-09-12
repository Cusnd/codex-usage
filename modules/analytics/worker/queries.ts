import { Value } from "@sinclair/typebox/value";
import { FormatRegistry } from "@sinclair/typebox";
import { FilterSchema, type Filter } from "../../contracts/query.js";
import { QueryEngine, queryStore, type Statement, type QueryFilter } from "../query-engine.js";
import { pricingInfo } from "../../settings/pricing.js";
import { stableJson } from "../../contracts/sync.js";
import { fail } from "../../platform/worker/http.js";
import { createRead, getRead, type ReadLease } from "../../sync/reads/snapshots.js";
import { resolveReadSettings } from "../../settings/read-settings.js";
import { executeV3Query } from "./executor.js";

export { defaultSettings } from '../../settings/defaults.js';

FormatRegistry.Set('date-time', value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));

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
    const byId=new Map(names.map(n=>[n.id,n.name]));for(const row of rows)if(row.key!==null&&byId.has(row.key))row.label=byId.get(row.key)?.trim()||'未命名项目';
  }
  return {data,meta:{source:'cloud',updatedAt:null,timezone:settings.timezone,warnings:[],lease_id:leaseId,cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version}}};
}

export { executeV3Query } from './executor.js';

export { loadSettings } from '../../settings/worker/load.js';

export { validSettings } from '../../settings/validation.js';
