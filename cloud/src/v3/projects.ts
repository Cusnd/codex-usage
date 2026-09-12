import { normalizeRemote, organizeProjects, resolveProjectAlias, type ManualProjectPartition, type ProjectEdge, type ProjectOrganization } from '../../../shared/usage-domain/projects';
import { stableJson, type UploadBatch } from '../../../shared/sync-v3';
import { fail, json, readJson, requireJson, requireSameOrigin, sha256 } from '../http';
import { advanceHead, chunks, cutOf, domain, endGuard, entityStatements, guard, isCasFailure, type Domain, type EntityMutation } from './store';
import { createRead, getRead } from './snapshots';

/** Collector ownership is part of identity even for old/third-party local project IDs. */
export async function cloudSourceProjectId(collectorId:string, localId:string):Promise<string> {
  return 'pc1:'+await sha256(stableJson([collectorId,localId]));
}
type SourceRow={source_project_id:string;collector_id:string;local_source_id:string;device_id:string;metadata:string};
type SessionRow={collector_id:string;source_id:string;generation:number;source_project_id:string;thread_id:string};
type EntityRow={entity_id:string;revision:number;payload:string|null};
type Rules={partitions:ManualProjectPartition[];names:Record<string,string>};
type SourceView={subtype:'source';id:string;collector_id:string;device_id:string;local_source_id:string;logical_project_id:string|null;[key:string]:unknown};
type Current={sources:SourceRow[];sessions:SessionRow[];entities:EntityRow[];rules:Rules;organization:ProjectOrganization};
export type ProjectPreparation={statements:D1PreparedStatement[];changes:EntityMutation[];organizationChanged:boolean};
const emptyOrganization=():ProjectOrganization=>({projects:[],membership:Object.create(null),aliases:Object.create(null),blockedEdges:[]});
const sourceValue=(row:SourceRow,logical:string|null):SourceView=>({...JSON.parse(row.metadata),subtype:'source',id:row.source_project_id,collector_id:row.collector_id,device_id:row.device_id,local_source_id:row.local_source_id,logical_project_id:logical});
const sessionKey=(s:SessionRow)=>stableJson([s.collector_id,s.source_id,s.generation,s.source_project_id,s.thread_id]);
const fileKey=(s:{collector_id:string;source_id:string})=>stableJson([s.collector_id,s.source_id]);

function organizationOf(rows:EntityRow[]):ProjectOrganization {
  const out=emptyOrganization();
  for(const row of rows){if(!row.payload)continue;const v=JSON.parse(row.payload);
    if(v.subtype==='logical'){out.projects.push(v.project);for(const member of v.project.members)out.membership[member]=v.project.id;}
    else if(v.subtype==='alias')out.aliases[v.id]=v.target;
    else if(v.subtype==='organization')out.blockedEdges=v.blocked_edges;
  }
  return out;
}
async function loadCurrent(db:D1Database,user:string):Promise<Current>{
  const results=await db.batch([
    db.prepare('SELECT source_project_id,collector_id,local_source_id,device_id,metadata FROM v3_project_sources WHERE user_id=? ORDER BY source_project_id').bind(user),
    db.prepare(`SELECT p.collector_id,p.source_id,p.generation,p.source_project_id,p.thread_id FROM v3_project_sessions p JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE p.user_id=? AND s.active=1`).bind(user),
    db.prepare('SELECT entity_id,revision,payload FROM v3_project_entities WHERE user_id=?').bind(user),
    db.prepare('SELECT partitions,names FROM v3_project_rules WHERE user_id=?').bind(user),
  ]);
  const sources=results[0].results as SourceRow[],sessions=results[1].results as SessionRow[],entities=results[2].results as EntityRow[],rules=results[3].results[0] as {partitions:string;names:string}|undefined;
  return {sources,sessions,entities,rules:rules?{partitions:JSON.parse(rules.partitions),names:JSON.parse(rules.names)}:{partitions:[],names:Object.create(null)},organization:organizationOf(entities)};
}
function repositoryProof(v:Record<string,unknown>):string|null {
  if(v.kind!=='git'||v.confidence!=='confirmed'||typeof v.repository!=='string'||!v.repository.startsWith('repo1:'))return null;
  try {const [host,port,path]=JSON.parse(v.repository.slice(6));if(typeof host!=='string'||typeof path!=='string'||!(port===null||Number.isInteger(port)&&port>0&&port<=65535))return null;
    const normalized=normalizeRemote(`ssh://${host}${port===null?'':':'+port}/${path}`);return normalized?.key===v.repository?v.repository:null;
  }catch{return null;}
}
/** Equality sets form a star around an unanchored node, preserving every reachable manual anchor. */
function evidenceEdges(current:Current):ProjectEdge[]{
  const groups=new Map<string,{reason:ProjectEdge['reason'];members:Set<string>}>(),anchored=new Set(current.rules.partitions.flatMap(p=>[...p.members]));
  const add=(key:string,reason:ProjectEdge['reason'],id:string)=>{if(!groups.has(key))groups.set(key,{reason,members:new Set()});groups.get(key)!.members.add(id);};
  const ids=new Set(current.sources.map(s=>s.source_project_id));
  for(const row of current.sources){const v=JSON.parse(row.metadata),repo=repositoryProof(v);if(repo)add('repo:'+repo,'primary-remote',row.source_project_id);
    if(v.kind==='git'&&typeof v.common_dir==='string'&&v.common_dir)add(stableJson(['common',row.collector_id,v.common_dir]),'local-repository',row.source_project_id);
    if(v.kind==='app'&&typeof v.app_project_id==='string'&&v.app_project_id)add(stableJson(['app',row.collector_id,v.app_project_id]),'app-project',row.source_project_id);
  }
  for(const s of current.sessions)if(ids.has(s.source_project_id))add('session:'+s.thread_id,'session',s.source_project_id);
  const edges:ProjectEdge[]=[];
  for(const {reason,members} of groups.values()){const sorted=[...members].sort(),center=sorted.find(id=>!anchored.has(id))||sorted[0];for(const id of sorted)if(id!==center)edges.push({a:center,b:id,reason});}
  return edges;
}
function compute(current:Current):ProjectOrganization {
  return organizeProjects({sources:current.sources.map(r=>({id:r.source_project_id,name:JSON.parse(r.metadata).name})),edges:evidenceEdges(current),partitions:current.rules.partitions,names:current.rules.names,previous:current.organization});
}
async function prepareEntities(db:D1Database,h:Domain,current:Current,statements:D1PreparedStatement[]):Promise<ProjectPreparation>{
  const organization=compute(current),values=new Map<string,unknown>(),old=new Map(current.entities.map(r=>[r.entity_id,r]));
  for(const row of current.sources)values.set('source:'+row.source_project_id,sourceValue(row,organization.membership[row.source_project_id]||null));
  for(const project of organization.projects)values.set('logical:'+project.id,{subtype:'logical',id:project.id,project});
  const activeLogicalIds=new Set(organization.projects.map(p=>p.id));
  for(const [id,target] of Object.entries(organization.aliases))if(activeLogicalIds.has(target))values.set('alias:'+id,{subtype:'alias',id,target});
  if(organization.projects.length||old.has('organization'))values.set('organization',{subtype:'organization',blocked_edges:organization.blockedEdges});
  const changes:EntityMutation[]=[];
  for(const id of new Set([...old.keys(),...values.keys()])){const value=values.get(id)??null,payload=value===null?null:stableJson(value),prior=old.get(id);if((prior?.payload??null)===payload)continue;changes.push({kind:'project',id,revision:(prior?.revision||0)+1,value});}
  for(const rows of chunks(changes))statements.push(db.prepare(`INSERT INTO v3_project_entities(user_id,entity_id,revision,payload) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.revision'),CASE WHEN json_type(value,'$.value')='null' THEN NULL ELSE json_extract(value,'$.value') END FROM json_each(?) WHERE true ON CONFLICT(user_id,entity_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`).bind(h.user_id,stableJson(rows)));
  if(changes.length)statements.push(db.prepare('UPDATE v3_sync_domains SET organization_version=organization_version+1 WHERE user_id=?').bind(h.user_id));
  return {statements,changes,organizationChanged:changes.length>0};
}

/** Prepared only; the apply caller publishes these with event changes under its existing CAS. */
export async function prepareProjectMetadata(db:D1Database,h:Domain,b:UploadBatch,deviceId:string):Promise<ProjectPreparation>{
  const touched=new Map<string,SourceRow>(),statements:D1PreparedStatement[]=[];
  const localIds=new Set([...b.metadata.flatMap(m=>m.type==='project'?[m.source_project_id]:[]),...b.records.flatMap(o=>o.context.source_project_id?[o.context.source_project_id]:[]),...b.sources.flatMap(s=>s.context.source_project_id?[s.context.source_project_id]:[])]);
  const ids=new Map(await Promise.all([...localIds].map(async id=>[id,await cloudSourceProjectId(b.collector_id,id)] as const)));
  const inputs=stableJson(b.sources.map(s=>({source_id:s.source_id,generation:s.generation})));
  // The common increment reads only its project/source evidence. The caller's final
  // domain CAS also protects this decision against concurrent manual organization edits.
  const initial=await db.batch([
    db.prepare('SELECT source_project_id,collector_id,local_source_id,device_id,metadata FROM v3_project_sources WHERE user_id=? AND source_project_id IN(SELECT value FROM json_each(?))').bind(h.user_id,stableJson([...ids.values()])),
    db.prepare('SELECT source_id,generation FROM v3_sources WHERE user_id=? AND collector_id=? AND active=1 AND source_id IN(SELECT json_extract(value,\'$.source_id\') FROM json_each(?))').bind(h.user_id,b.collector_id,inputs),
    db.prepare(`SELECT p.collector_id,p.source_id,p.generation,p.source_project_id,p.thread_id FROM v3_project_sessions p JOIN json_each(?) j ON p.source_id=json_extract(j.value,'$.source_id') AND p.generation=json_extract(j.value,'$.generation') WHERE p.user_id=? AND p.collector_id=?`).bind(inputs,h.user_id,b.collector_id),
  ]);
  const sources=new Map((initial[0].results as SourceRow[]).map(r=>[r.source_project_id,r]));
  const activeGenerations=new Map((initial[1].results as {source_id:string;generation:number}[]).map(r=>[r.source_id,r.generation]));
  const persistedSessions=initial[2].results as SessionRow[],persistedKeys=new Set(persistedSessions.map(sessionKey));
  for(const [local,id] of ids){const prior=sources.get(id);if(prior&&(prior.collector_id!==b.collector_id||prior.local_source_id!==local))fail(409,'PROJECT_ID_COLLISION','项目来源身份冲突。');
    const metadata=b.metadata.filter(m=>m.type==='project'&&m.source_project_id===local).at(-1);
    const value=metadata?.type==='project'?metadata.value:prior?JSON.parse(prior.metadata):{kind:'unresolved',name:null,root:null,reason:'metadata-pending'};
    // Session links are derived from authenticated projected observations, never from an arbitrary metadata list.
    const evidence=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='thread_ids'&&key!=='id').map(([key,v])=>[key,typeof v==='string'||v===null?v:null]));
    const row={source_project_id:id,collector_id:b.collector_id,local_source_id:local,device_id:deviceId,metadata:stableJson(evidence)};
    sources.set(id,row);if(!prior||stableJson(row)!==stableJson(prior))touched.set(id,row);
  }
  for(const rows of chunks([...touched.values()]))statements.push(db.prepare(`INSERT INTO v3_project_sources(user_id,source_project_id,collector_id,local_source_id,device_id,metadata) SELECT ?,json_extract(value,'$.source_project_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.local_source_id'),json_extract(value,'$.device_id'),json_extract(value,'$.metadata') FROM json_each(?) WHERE true ON CONFLICT(user_id,source_project_id) DO UPDATE SET metadata=excluded.metadata`).bind(h.user_id,stableJson(rows)));
  const incoming=new Map<string,SessionRow>();
  for(const o of b.records)if(o.session_trusted&&o.context.source_project_id){const row={collector_id:b.collector_id,source_id:o.source_id,generation:o.generation,source_project_id:ids.get(o.context.source_project_id)!,thread_id:o.context.thread_id};incoming.set(sessionKey(row),row);}
  const newSessions=[...incoming.values()].filter(row=>!persistedKeys.has(sessionKey(row)));
  if(!touched.size&&!newSessions.length&&b.sources.every(s=>activeGenerations.get(s.source_id)===s.generation&&!(s.generation_complete&&s.replace_end)))return {statements:[],changes:[],organizationChanged:false};
  for(const rows of chunks(newSessions))statements.push(db.prepare(`INSERT INTO v3_project_sessions(user_id,collector_id,source_id,generation,source_project_id,thread_id) SELECT ?,json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.source_project_id'),json_extract(value,'$.thread_id') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(h.user_id,stableJson(rows)));
  const current=await loadCurrent(db,h.user_id);
  current.sources=[...new Map([...current.sources,...sources.values()].map(row=>[row.source_project_id,row])).values()];
  const selected=new Map<string,number>();
  for(const s of b.sources){const active=activeGenerations.get(s.source_id);selected.set(fileKey({collector_id:b.collector_id,source_id:s.source_id}),active===undefined||active===s.generation||s.generation_complete&&s.replace_end?s.generation:active);
    if(selected.get(fileKey({collector_id:b.collector_id,source_id:s.source_id}))===s.generation)for(const row of persistedSessions)if(row.source_id===s.source_id&&row.generation===s.generation)incoming.set(sessionKey(row),row);
    if(s.generation_complete&&s.replace_end)statements.push(db.prepare('DELETE FROM v3_project_sessions WHERE user_id=? AND collector_id=? AND source_id=? AND generation<?').bind(h.user_id,b.collector_id,s.source_id,s.generation));
  }
  current.sessions=[...new Map([...current.sessions,...incoming.values()].filter(s=>!selected.has(fileKey(s))||selected.get(fileKey(s))===s.generation).map(s=>[sessionKey(s),s])).values()];
  return prepareEntities(db,h,current,statements);
}

export async function prepareProjectDeletion(db:D1Database,h:Domain,deviceId:string):Promise<ProjectPreparation>{
  const current=await loadCurrent(db,h.user_id),removed=new Set(current.sources.filter(s=>s.device_id===deviceId).map(s=>s.source_project_id));
  current.sources=current.sources.filter(s=>!removed.has(s.source_project_id));current.sessions=current.sessions.filter(s=>!removed.has(s.source_project_id));
  return prepareEntities(db,h,current,[db.prepare('DELETE FROM v3_project_sessions WHERE user_id=? AND source_project_id IN(SELECT source_project_id FROM v3_project_sources WHERE user_id=? AND device_id=?)').bind(h.user_id,h.user_id,deviceId),db.prepare('DELETE FROM v3_project_sources WHERE user_id=? AND device_id=?').bind(h.user_id,deviceId)]);
}

/** A legacy baseline has many collectors. Compute its project organization once. */
export async function prepareLegacyProjects(db:D1Database,h:Domain,sources:{collector_id:string;device_id:string;project_id:string|null;project_name:string|null}[]):Promise<ProjectPreparation>{
  const current=await loadCurrent(db,h.user_id),rows=new Map(current.sources.map(row=>[row.source_project_id,row])),touched=new Map<string,SourceRow>();
  for(const source of sources){if(!source.project_id)continue;const id=await cloudSourceProjectId(source.collector_id,source.project_id),row:SourceRow={source_project_id:id,collector_id:source.collector_id,local_source_id:source.project_id,device_id:source.device_id,metadata:stableJson({kind:'unresolved',name:source.project_name,root:source.project_name,reason:'legacy-path'})};
    const prior=rows.get(id);if(prior&&(prior.collector_id!==row.collector_id||prior.local_source_id!==row.local_source_id))fail(409,'PROJECT_ID_COLLISION','项目来源身份冲突。');
    if(!prior||stableJson(prior)!==stableJson(row))touched.set(id,row);rows.set(id,row);
  }
  if(!touched.size)return {statements:[],changes:[],organizationChanged:false};
  current.sources=[...rows.values()];
  const statements=chunks([...touched.values()]).map(group=>db.prepare(`INSERT INTO v3_project_sources(user_id,source_project_id,collector_id,local_source_id,device_id,metadata) SELECT ?,json_extract(value,'$.source_project_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.local_source_id'),json_extract(value,'$.device_id'),json_extract(value,'$.metadata') FROM json_each(?) WHERE true ON CONFLICT(user_id,source_project_id) DO UPDATE SET metadata=excluded.metadata`).bind(h.user_id,stableJson(group)));
  return prepareEntities(db,h,current,statements);
}

export async function projectView(db:D1Database,user:string,leaseId?:string){
  const lease=await getRead(db,user,leaseId||(await createRead(db,user,'full',[])).lease_id);
  const rows=(await db.prepare(`SELECT entity_id,revision,payload FROM v3_entity_versions WHERE user_id=? AND epoch=? AND kind='project' AND valid_from<=? AND (valid_to IS NULL OR ?<valid_to) AND payload IS NOT NULL ORDER BY entity_id`).bind(user,lease.epoch,lease.cut,lease.cut).all<EntityRow>()).results;
  const organization=organizationOf(rows),sources=rows.flatMap(r=>{const v=JSON.parse(r.payload!);return v.subtype==='source'?[v]:[];});
  await getRead(db,user,lease.lease_id);
  return {cut:{dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version},lease_id:lease.lease_id,projects:organization.projects,sources,aliases:organization.aliases,blocked_edges:organization.blockedEdges};
}
type ProjectOperation={operation_id:string;base_organization_version?:number;action:'merge'|'split'|'reset'|'rename';project_ids?:string[];project_id?:string;groups?:{source_ids:string[];name?:string}[];name?:string|null};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifiers=(v:unknown,min=1):v is string[]=>Array.isArray(v)&&v.length>=min&&v.length<=500&&v.every(id=>typeof id==='string'&&id.length>0&&id.length<=2048)&&new Set(v).size===v.length;
function validateOperation(v:unknown):asserts v is ProjectOperation {
  if(!object(v))return fail(400,'INVALID_PROJECT_OPERATION','项目操作无效。');
  if(typeof v.operation_id!=='string'||!v.operation_id||v.operation_id.length>256||v.base_organization_version!==undefined&&(!Number.isSafeInteger(v.base_organization_version)||Number(v.base_organization_version)<0))fail(400,'INVALID_PROJECT_OPERATION','项目操作无效。');
  const fields:Record<string,string[]>={merge:['project_ids','name'],split:['project_id','groups'],reset:['project_ids'],rename:['project_id','name']};
  if(typeof v.action!=='string'||!Object.hasOwn(fields,v.action)||Object.keys(v).some(k=>!['operation_id','base_organization_version','action',...fields[String(v.action)]].includes(k)))fail(400,'INVALID_PROJECT_OPERATION','项目操作字段无效。');
  if(v.name!==undefined&&v.name!==null&&(typeof v.name!=='string'||!v.name.trim()||v.name.length>200))fail(400,'INVALID_PROJECT_NAME','项目名称无效。');
  if(['merge','reset'].includes(String(v.action))&&!identifiers(v.project_ids,v.action==='merge'?2:1)||['split','rename'].includes(String(v.action))&&(typeof v.project_id!=='string'||!v.project_id||v.project_id.length>2048)||v.action==='rename'&&!Object.hasOwn(v,'name'))fail(400,'INVALID_PROJECT_OPERATION','缺少项目范围。');
  if(v.action==='split'&&(!Array.isArray(v.groups)||v.groups.length<2||v.groups.length>500||v.groups.some(g=>!object(g)||Object.keys(g).some(k=>!['source_ids','name'].includes(k))||!identifiers(g.source_ids)||g.name!==undefined&&(typeof g.name!=='string'||!g.name.trim()||g.name.length>200))))fail(400,'INVALID_PROJECT_OPERATION','拆分分组无效。');
}
function applyOperation(current:Current,op:ProjectOperation){
  const canonical=(id:string)=>resolveProjectAlias(id,current.organization.aliases),find=(id:string)=>current.organization.projects.find(p=>p.id===canonical(id))||fail(404,'PROJECT_NOT_FOUND','项目不存在。');
  const removeMembers=(ids:Set<string>)=>{current.rules.partitions=current.rules.partitions.map(p=>({...p,members:p.members.filter(id=>!ids.has(id))})).filter(p=>p.members.length);};
  if(op.action==='rename'){const project=find(op.project_id!);for(const id of Object.keys(current.rules.names))if(canonical(id)===project.id)delete current.rules.names[id];if(op.name!==null)current.rules.names[project.id]=op.name!.trim();return;}
  if(op.action==='merge'){
    const projects=[...new Map(op.project_ids!.map(id=>{const p=find(id);return [p.id,p] as const;})).values()];if(projects.length<2)fail(400,'INVALID_PROJECT_OPERATION','至少选择两个不同项目。');
    const members=[...new Set(projects.flatMap(p=>p.members))].sort(),id=projects.map(p=>p.id).sort()[0];removeMembers(new Set(members));current.rules.partitions.push({id,members});if(op.name)current.rules.names[id]=op.name.trim();
  }else if(op.action==='split'){
    const project=find(op.project_id!),members=op.groups!.flatMap(g=>g.source_ids);if(new Set(members).size!==members.length||stableJson([...members].sort())!==stableJson([...project.members].sort()))fail(400,'INVALID_PROJECT_PARTITION','拆分必须恰好覆盖当前项目的所有来源。');
    removeMembers(new Set(members));const keeper=[...project.members].sort()[0];for(const group of op.groups!){const sorted=[...group.source_ids].sort(),id=sorted.includes(keeper)?project.id:'manual:'+op.operation_id+':'+op.groups!.indexOf(group);current.rules.partitions.push({id,members:sorted});if(group.name)current.rules.names[id]=group.name.trim();}
  }else {const projects=op.project_ids!.map(find);removeMembers(new Set(projects.flatMap(p=>p.members)));}
}
export async function performProjectOperation(db:D1Database,user:string,body:unknown){
  validateOperation(body);const hash=await sha256(stableJson(body));
  for(let attempt=0;attempt<3;attempt++){
    const saved=await db.prepare('SELECT content_hash,result FROM v3_operations WHERE user_id=? AND operation_id=?').bind(user,body.operation_id).first<{content_hash:string;result:string}>();if(saved){if(saved.content_hash!==hash)fail(409,'OPERATION_CONFLICT','该操作标识已对应其他内容。');return JSON.parse(saved.result);}
    const h=await domain(db,user);if(h.mode!=='ready')fail(409,'DATASET_UPDATING','项目数据正在更新，请稍后重试。');if(body.base_organization_version!==undefined&&body.base_organization_version!==h.organization_version)fail(409,'PROJECT_VERSION_CONFLICT','项目组织已更新，请刷新后重试。');
    const current=await loadCurrent(db,user);applyOperation(current,body);const prepared=await prepareEntities(db,h,current,[]),op=crypto.randomUUID();
    const next=compute(current),result={cut:{...cutOf(h),commit_seq:h.commit_seq+Number(prepared.changes.length>0),organization_version:h.organization_version+Number(prepared.organizationChanged)},projects:next.projects,sources:current.sources.map(s=>sourceValue(s,next.membership[s.source_project_id]||null)),aliases:next.aliases,blocked_edges:next.blockedEdges};
    try{await db.batch([guard(db,h,op),db.prepare('INSERT INTO v3_project_rules(user_id,partitions,names) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET partitions=excluded.partitions,names=excluded.names').bind(user,stableJson(current.rules.partitions),stableJson(current.rules.names)),...prepared.statements,...await entityStatements(db,h,prepared.changes),db.prepare('INSERT INTO v3_operations(user_id,operation_id,content_hash,result) VALUES(?,?,?,?)').bind(user,body.operation_id,hash,stableJson(result)),advanceHead(db,h,prepared.changes.length>0),endGuard(db,user,op)]);return result;}catch(error){if(isCasFailure(error)||error instanceof Error&&/UNIQUE constraint failed.*v3_operations/.test(error.message))continue;throw error;}
  }
  return fail(409,'WRITE_CONFLICT','项目正在更新，请重试同一操作。');
}
export async function projectRoute(request:Request,env:Env,path:string,userId:string):Promise<Response|null>{
  if(path==='/api/v3/projects'&&request.method==='GET')return json(await projectView(env.DB,userId,new URL(request.url).searchParams.get('lease_id')||undefined));
  if(path==='/api/v3/projects/operations'&&request.method==='POST'){requireSameOrigin(request,env);requireJson(request);return json(await performProjectOperation(env.DB,userId,await readJson(request,131072)));}
  return null;
}
