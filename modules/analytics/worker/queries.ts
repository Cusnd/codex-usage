import { Value } from "@sinclair/typebox/value";
import { FormatRegistry } from "@sinclair/typebox";
import { FilterSchema, type Filter } from "../../contracts/query.js";
import type { ProjectLabel } from '../../contracts/responses.js';
import { QueryEngine, queryStore, type Statement, type QueryFilter } from "../query-engine.js";
import { pricingInfo } from "../../settings/pricing.js";
import { fail } from "../../platform/worker/http.js";
import { createPageRead, getRead } from "../../sync/reads/snapshots.js";
import { resolveReadSettings } from "../../settings/read-settings.js";
import { executeV3Query } from "./executor.js";
import { projectLabels } from '../../organization/worker/project-identities.js';
import { cloudProjectKinds } from './project-kinds.js';
import { projectOptions } from './project-options.js';
import { validUsageRoute } from './query-input.js';

export { defaultSettings } from '../../settings/defaults.js';
FormatRegistry.Set('date-time', value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));

function* usageData(engine:QueryEngine,route:string,p:Record<string,string>,f:QueryFilter,limit:number,offset:number,settings:import('../../contracts/settings.js').Settings):Generator<Statement,unknown,any>{
  const run=<T>(g:Generator<Statement,T,any>)=>g;
  let data:unknown;
  if(route==='settings')data=settings;
  else if(route==='pricing')data=pricingInfo();
  else if(route==='capabilities')data={mode:'cloud',deviceFilter:true,localControl:false,refresh:'read'};
  else if(route==='local/summary')data=yield* run(engine.summary(f));
  else if(route==='local/scope')data=yield* run(engine.scope(f));
  else if(route==='local/scope-summary')data=yield* run(engine.scopeSummary(f));
  else if(route==='local/overview')data=yield* run(engine.overview(f,p.bucket==='hour'||p.bucket==='day'||p.bucket==='week'||p.bucket==='month'?p.bucket:'auto'));
  else if(route==='local/project-options')data=yield* projectOptions(f,p.q?.trim()||'',limit,offset);
  else if(route==='local/filters')data=yield* run(engine.filters(f,{projects:p.projects!=='false'}));
  else if(route==='local/trend')data=yield* run(engine.trend(f,p.bucket==='hour'||p.bucket==='week'||p.bucket==='month'?p.bucket:'day'));
  else if(route==='local/breakdown'){if(!['project','model','effort'].includes(p.groupBy))fail(400,'INVALID_FILTER','分组无效。');data=yield* run(engine.breakdown(f,p.groupBy as 'project'|'model'|'effort',limit,offset));}
  else if(route==='local/threads'){const cache=p.cacheBelow===undefined?undefined:Number(p.cacheBelow);if(cache!==undefined&&(!Number.isFinite(cache)||cache<0||cache>1))fail(400,'INVALID_FILTER','缓存比例无效。');data=yield* run(engine.threads(f,limit,offset,p.sort,cache,p.q));}
  else if(route==='local/turns')data=yield* run(engine.allTurns({...f,turnId:p.missingTurn==='true'?null:p.turnId},limit,offset,p.sort,p.q));
  else if(route==='local/compare'){const by=p.groupBy||'project';if(!['project','model','effort','thread'].includes(by)||!!p.baselineFrom!==!!p.baselineTo||p.baselineFrom&&!(Date.parse(p.baselineFrom)<Date.parse(p.baselineTo)))fail(400,'INVALID_FILTER','对比范围无效。');data=yield* run(engine.compare(f,by as 'project'|'model'|'effort'|'thread',p.baselineFrom,p.baselineTo));}
  else if(route==='status'){const summary=yield* run(engine.summary()),base={running:false,startedAt:null,updatedAt:null,error:null,filesScanned:0,filesChanged:0,events:summary.eventCount,issues:summary.incompleteEvents},account={...base,provider:null,fallbackReason:null,errorCode:null,accountId:null,identityKey:null,identityConfirmed:false,available:false,stale:true};data={local:base,account:base,accountLimits:account,accountHistory:account};}
  else {const match=/^local\/threads\/([^/]+)(?:\/(agents|turns))?$/.exec(route);if(!match)return fail(404,'NOT_FOUND','接口不存在。');const id=decodeURIComponent(match[1]);data=yield*(match[2]==='agents'?run(engine.agents(id,f)):match[2]==='turns'?run(engine.turns(id,f,limit,offset,p.sort)):run(engine.detail(id)));if(!data)fail(404,'NOT_FOUND','任务不存在。');}
  return data;
}

/** Traverse only documented identity fields; response IDs stay unchanged. */
function referencedProjects(data:unknown,route:string,groupBy:string|undefined):string[]{
  const ids=new Set<string>(),pending:unknown[]=[data];
  while(pending.length){const value=pending.pop();if(Array.isArray(value)){pending.push(...value);continue;}if(!value||typeof value!=='object')continue;
    for(const [key,child] of Object.entries(value)){if(key==='project'&&typeof child==='string'&&child)ids.add(child);else if(key==='projects'&&Array.isArray(child))for(const id of child)if(typeof id==='string'&&id)ids.add(id);if(child&&typeof child==='object')pending.push(child);}
  }
  if((route==='local/breakdown'||route==='local/compare')&&(groupBy||'project')==='project'&&data&&typeof data==='object'&&'items' in data)
    for(const row of (data as {items:{key:string|null}[]}).items)if(row.key)ids.add(row.key);
  return [...ids];
}

function* selectedProject(id:string):Generator<Statement,string,any>{
  const seen=new Set<string>();let current=id;
  while(!seen.has(current)){
    seen.add(current);if(seen.size>256)return fail(409,'PROJECT_IDENTITY_INVALID','项目引用链无效。');
    const rows:{payload:string}[]=yield {sql:"SELECT payload FROM versions WHERE kind='project' AND entity_id IN(SELECT value FROM json_each(?)) ORDER BY entity_id",params:[JSON.stringify(['alias:'+current,'source:'+current])]};
    const links=rows.map(row=>JSON.parse(row.payload) as {subtype:string;target?:string;logical_project_id?:string|null});
    const target=links.find(link=>link.subtype==='alias')?.target||links.find(link=>link.subtype==='source')?.logical_project_id;
    if(!target||target===current)return current;current=target;
  }
  return fail(409,'PROJECT_IDENTITY_INVALID','项目引用链无效。');
}

export async function queryUsage(db:D1Database,user:string,url:URL,route:string) {
  if(!validUsageRoute(route))fail(404,'NOT_FOUND','接口不存在。');
  const leaseId=url.searchParams.get('lease_id')||(await createPageRead(db,user,[...new Set(url.searchParams.getAll('deviceIds'))])).lease_id;
  const lease=await getRead(db,user,leaseId,'settings'),settings=resolveReadSettings(lease.settings,url),p=Object.fromEntries(url.searchParams),f:QueryFilter={};
  for(const key of ['from','to','project','model','effort','threadId','unknown'] as const)if(p[key]!==undefined)(f as Record<string,unknown>)[key]=p[key];
  if(url.searchParams.has('unknowns'))f.unknowns=url.searchParams.getAll('unknowns') as Filter['unknowns'];
  if(!Value.Check(FilterSchema,f)||[f.from,f.to].some(v=>v&&!Number.isFinite(Date.parse(v)))||f.from&&f.to&&Date.parse(f.from)>=Date.parse(f.to)||[...(f.unknown?[f.unknown]:[]),...(f.unknowns||[])].some(k=>(f as any)[k]!==undefined))fail(400,'INVALID_FILTER','筛选范围无效。');
  const limit=Number(p.limit??50),offset=Number(p.offset??0);if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)fail(400,'INVALID_FILTER','分页参数无效。');
  const engine=new QueryEngine(queryStore(settings),{projectKinds:filter=>cloudProjectKinds(lease,filter)}),selected=p.project;
  const result=await executeV3Query(db,user,leaseId,(function*():Generator<Statement,{data:unknown;labels:ProjectLabel[]},any>{
    if(f.project)f.project=yield* selectedProject(f.project);
    if(p.q?.trim()&&route!=='local/project-options'){const q=p.q.trim(),rows=yield {sql:"SELECT id FROM logical_projects WHERE instr(lower(COALESCE(name,'')),lower(?))>0 UNION SELECT logical_id id FROM project_membership WHERE logical_id IS NOT NULL AND (instr(lower(COALESCE(source_name,'')),lower(?))>0 OR instr(lower(COALESCE(source_root,'')),lower(?))>0)",params:[q,q,q]};f.qProjects=rows.map((row:{id:string})=>row.id);}
    const data=yield* usageData(engine,route,p,f,limit,offset,settings);
    const optionLabels=route==='local/project-options'?(data as {items:ProjectLabel[]}).items:[];
    const ids=referencedProjects(data,route,p.groupBy);if(f.project)ids.push(f.project);
    const existing=new Set(optionLabels.map(label=>label.id)),labels=[...optionLabels,...(yield* projectLabels(ids.filter(id=>!existing.has(id))))];
    if(selected&&selected!==f.project){const canonical=labels.find(label=>label.id===f.project);if(canonical)labels.push({...canonical,id:selected});}
    if((route==='local/breakdown'||route==='local/compare')&&(p.groupBy||'project')==='project'&&data&&typeof data==='object'&&'items' in data){
      const byId=new Map(labels.map(label=>[label.id,label.name]));for(const row of (data as {items:{key:string|null;label:string}[]}).items)if(row.key&&byId.has(row.key))row.label=byId.get(row.key)!;
    }
    return {data,labels};
  })());
  return {data:result.data,meta:{source:'cloud',updatedAt:null,timezone:settings.timezone,warnings:[],lease_id:leaseId,projectLabels:result.labels,cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version}}};
}

export { executeV3Query } from './executor.js';
export { loadSettings } from '../../settings/worker/load.js';
export { validSettings } from '../../settings/validation.js';
