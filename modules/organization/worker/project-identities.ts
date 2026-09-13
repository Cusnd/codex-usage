import {projectDisplay,type LogicalProject} from '../projects.js';
import type {ProjectLabel} from '../../contracts/responses.js';
import type {Statement} from '../../analytics/query-engine.js';

export type DisplaySource={id:string;kind?:string;name?:string|null;root?:string|null};
export type DisplayThread={id:string;title:string|null;sourceProjectId:string|null;parentId?:string|null};

/** Index once per read; retain the original source order and the shared title precedence. */
export function projectDisplays(projects:LogicalProject[],sources:DisplaySource[],threads:DisplayThread[]){
  const bySource=new Map(sources.map((source,order)=>[source.id,{source,order}])),threadsBySource=new Map<string,DisplayThread[]>();
  for(const thread of threads){if(!thread.sourceProjectId)continue;const group=threadsBySource.get(thread.sourceProjectId);if(group)group.push(thread);else threadsBySource.set(thread.sourceProjectId,[thread]);}
  return projects.map(project=>{
    const evidence=project.members.flatMap(id=>{const source=bySource.get(id);return source?[source]:[];}).sort((a,b)=>a.order-b.order).map(({source})=>source);
    return {...project,display:projectDisplay(project,evidence,project.members.flatMap(id=>threadsBySource.get(id)||[]))};
  });
}

/** Internal backend page identities. The supplied IDs come from versioned logical-project fields. */
export function* projectLabels(ids:readonly string[]):Generator<Statement,ProjectLabel[],any>{
  const requested=[...new Set(ids.filter(Boolean))];if(!requested.length)return [];
  const projects:LogicalProject[]=[],sources:DisplaySource[]=[];
  // Bound SQL bindings for compatibility routes whose response legitimately contains many IDs.
  for(let offset=0;offset<requested.length;offset+=200){
    const rows:{payload:string}[]=yield {sql:"SELECT payload FROM versions WHERE kind='project' AND entity_id IN(SELECT 'logical:'||value FROM json_each(?)) ORDER BY entity_id",params:[JSON.stringify(requested.slice(offset,offset+200))]};
    projects.push(...rows.map(row=>JSON.parse(row.payload).project as LogicalProject));
  }
  const members=[...new Set(projects.flatMap(project=>project.members))];
  for(let offset=0;offset<members.length;offset+=200){
    const rows:{payload:string}[]=yield {sql:"SELECT payload FROM versions WHERE kind='project' AND entity_id IN(SELECT 'source:'||value FROM json_each(?)) ORDER BY entity_id",params:[JSON.stringify(members.slice(offset,offset+200))]};
    sources.push(...rows.map(row=>JSON.parse(row.payload) as DisplaySource));
  }
  sources.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const bySource=new Map(sources.map(source=>[source.id,source]));
  const sessionMembers=[...new Set(projects.flatMap(project=>{
    const evidence=project.members.flatMap(id=>{const source=bySource.get(id);return source?[source]:[];});
    return evidence.length&&evidence.every(source=>source.kind==='session')?evidence.map(source=>source.id):[];
  }))];
  const threads:DisplayThread[]=sessionMembers.length?yield {sql:"SELECT entity_id id,json_extract(payload,'$.title') title,json_extract(payload,'$.source_project_id') sourceProjectId,json_extract(payload,'$.subagent_parent_id') parentId FROM versions WHERE kind='thread' AND json_extract(payload,'$.source_project_id') IN(SELECT value FROM json_each(?)) ORDER BY entity_id",params:[JSON.stringify(sessionMembers)]}:[];
  const seen=new Set(threads.map(thread=>thread.sourceProjectId)),missing=sessionMembers.filter(id=>!seen.has(id));
  if(missing.length)threads.push(...(yield {sql:"SELECT DISTINCT thread_id id,NULL title,json_extract(payload,'$.source_project_id') sourceProjectId,NULL parentId FROM versions WHERE kind='event' AND json_extract(payload,'$.source_project_id') IN(SELECT value FROM json_each(?)) ORDER BY thread_id",params:[JSON.stringify(missing)]}));
  const displays=new Map(projectDisplays(projects,sources,threads).map(project=>[project.id,project.display]));
  return requested.map(id=>({id,...displays.get(id)??{name:'归属待识别',kind:'unknown' as const}}));
}
