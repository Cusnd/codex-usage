import type { Store } from '../storage/sqlite.js';
import type { ResolvedProjectSource } from '../organization/source-node.js';
import type { QueryFilter } from '../analytics/filter.js';
import { where, type QueryOperation } from '../analytics/sqlite.js';
import type { ProjectLabel, Page } from '../contracts/responses.js';

/** Read projection only: source logs, canonical events and existing project paths stay intact. */
export function localAnalyticsStore(store: Store, filter: QueryFilter = {}, narrowScope = false) {
  const source = `LEFT JOIN local_v3_events v ON v.event_id=e.event_key
    LEFT JOIN collector_projects p ON p.id=json_extract(v.data,'$.source_project_id')`;
  const project = `CASE WHEN json_extract(p.value,'$.kind')='session' THEN 'session:'||e.thread_id ELSE e.project END`;
  // This redundant predicate selects a superset of the final CASE equality.
  // Keep the outer filter authoritative when source metadata changes or is absent.
  const projectFilter = filter.project === undefined ? {sql:'',params:[] as string[]}
    : filter.project.startsWith('session:')
      ? {sql:' AND (e.project=? OR e.thread_id=?)',params:[filter.project,filter.project.slice(8)]}
      : {sql:' AND e.project=?',params:[filter.project]};
  // Composite overview/scope statements reuse the projection. Bound that shared
  // input before SQLite materializes it; these operations never broaden the scope.
  const scopeFilter=narrowScope?where({...filter,project:undefined,q:undefined,qProjects:undefined,
    unknown:filter.unknown==='project'?undefined:filter.unknown,unknowns:filter.unknowns?.filter(k=>k!=='project')}):{sql:'',params:[]};
  const constraints=projectFilter.sql+(scopeFilter.sql?' AND '+scopeFilter.sql.slice(6):'');
  const projectionParams=[...projectFilter.params,...scopeFilter.params];
  const scope = `WITH effective_events AS (
    SELECT e.file,e.event_key,e.thread_id,e.turn_id,e.response_id,e.at,${project} project,
      e.model,e.effort,e.kind,e.signature,e.input_tokens,e.cached_input_tokens,e.cache_write_input_tokens,
      e.output_tokens,e.reasoning_output_tokens,e.total_tokens,e.incomplete,e.excluded,e.active,e.service_tier,e.service_tier_source,
      CASE WHEN json_extract(p.value,'$.kind')='session' THEN 'session' WHEN json_extract(p.value,'$.kind') IN('git','app') THEN 'project' ELSE 'unknown' END project_kind
    FROM usage_events e ${source} WHERE e.active=1${constraints}),
    threads AS (SELECT t.id,COALESCE((SELECT ${project} FROM usage_events e ${source}
      WHERE e.active=1 AND e.thread_id=t.id ORDER BY e.at DESC,e.event_key LIMIT 1),t.project) project,
      t.source,t.parent_id,t.subagent_parent_id,t.forked_from_id,t.title,t.title_updated_at FROM main.threads t)`;
  const scoped = (sql: string) => sql.startsWith('WITH RECURSIVE ') ? scope.replace('WITH ', 'WITH RECURSIVE ') + ',' + sql.slice(15)
    : sql.startsWith('WITH ') ? scope + ',' + sql.slice(5) : scope + ' ' + sql;
  return {
    forQuery: (next: QueryFilter, operation: QueryOperation) => {
      const needsIdentity = next.project !== undefined || next.unknown === 'project' || next.unknowns?.includes('project') || !!next.q?.trim() || !!next.qProjects?.length;
      return (operation === 'summary' || operation === 'trend') && !needsIdentity ? store : localAnalyticsStore(store,next,operation==='overview'||operation==='scopeSummary');
    },
    settings: () => store.settings(),
    readSnapshot: <T>(read: () => T) => store.readSnapshot(read),
    all: (sql: string, params: Parameters<Store['all']>[1] = []) => store.all(scoped(sql), [...projectionParams,...params]),
    one: (sql: string, params: Parameters<Store['one']>[1] = []) => store.one(scoped(sql), [...projectionParams,...params]),
  };
}

/** Classification is based on source evidence, never on a session-looking path alone. */
export function localProjectKinds() {
  return {sql:`SELECT project,CASE MAX(priority) WHEN 2 THEN 'session' ELSE 'project' END kind FROM (
    SELECT project,2 priority FROM effective_events WHERE project_kind='session' GROUP BY project
    UNION ALL SELECT paths.value project,1 priority FROM collector_projects p,
      json_each(json_array(json_extract(p.value,'$.root'),json_extract(p.value,'$.observedCwd'))) paths
      WHERE json_extract(p.value,'$.kind') IN('git','app') AND paths.value IS NOT NULL
  ) GROUP BY project`,params:[]};
}

export function localProjectLabels(store: Store, ids: string[]): ProjectLabel[] {
  if(!ids.length)return [];
  return store.readSnapshot(() => {
    const sources = store.all<{value: string}>(`SELECT value FROM collector_projects WHERE json_extract(value,'$.kind')<>'session'
      AND (json_extract(value,'$.observedCwd') IN(SELECT value FROM json_each(?)) OR json_extract(value,'$.root') IN(SELECT value FROM json_each(?))) ORDER BY id`,[JSON.stringify(ids),JSON.stringify(ids)]).map(row => JSON.parse(row.value) as ResolvedProjectSource);
    const byPath = new Map<string,ResolvedProjectSource>();
    for(const source of sources)for(const key of [source.observedCwd,source.root])if(key&&!byPath.has(key))byPath.set(key,source);
    const threadIds = ids.filter(id => id.startsWith('session:')).map(id => id.slice(8));
    const titles = new Map(store.all<{id: string; title: string | null}>('SELECT id,title FROM threads WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(threadIds)]).map(row => [row.id,row.title]));
    const sessions = new Set(threadIds.length?store.all<{id:string}>(`SELECT DISTINCT e.thread_id id FROM usage_events e
      JOIN local_v3_events v ON v.event_id=e.event_key JOIN collector_projects p ON p.id=json_extract(v.data,'$.source_project_id')
      WHERE e.active=1 AND e.thread_id IN(SELECT value FROM json_each(?)) AND json_extract(p.value,'$.kind')='session'`,[JSON.stringify(threadIds)]).map(row=>row.id):[]);
    return ids.map(id => {
      if (id.startsWith('session:')&&sessions.has(id.slice(8))) return {id, name: titles.get(id.slice(8))?.trim() || `会话 ${id.slice(8,16)}`, kind:'session' as const};
      const source = byPath.get(id);
      return {id, name: source?.name?.trim() || id.split(/[\\/]/).filter(Boolean).at(-1) || '归属待识别', kind:source?.kind && source.kind !== 'unresolved' ? source.kind : 'unknown'};
    });
  });
}

/** Only the current page crosses the API boundary, including when searching titles. */
export function localProjectOptions(store:Store, filter:QueryFilter, q:string, limit:number, offset:number):Page<ProjectLabel> {
  const f={...filter,project:undefined,unknown:filter.unknown==='project'?undefined:filter.unknown,unknowns:filter.unknowns?.filter(k=>k!=='project')};
  const w=where(f),executor=localAnalyticsStore(store,f,true),needle=q.trim();
  const scope=`WITH candidates AS (SELECT project id,MAX(project_kind='session') is_session FROM effective_events ${w.sql || 'WHERE 1=1'} AND project IS NOT NULL GROUP BY project),
    ${needle?`source_names AS MATERIALIZED (SELECT paths.value project,json_extract(p.value,'$.name') name,
      ROW_NUMBER() OVER(PARTITION BY paths.value ORDER BY p.id) ordinal FROM collector_projects p,
      json_each(json_array(json_extract(p.value,'$.root'),json_extract(p.value,'$.observedCwd'))) paths
      WHERE json_extract(p.value,'$.kind')<>'session' AND paths.value IS NOT NULL),
    named AS (SELECT c.id,CASE WHEN c.is_session THEN COALESCE((SELECT NULLIF(trim(title),'') FROM main.threads WHERE id=substr(c.id,9)),'会话 '||substr(c.id,9,8)) ELSE n.name END name
      FROM candidates c LEFT JOIN source_names n ON n.project=c.id AND n.ordinal=1),
    matches AS (SELECT id FROM named WHERE instr(lower(id),lower(?))>0 OR instr(lower(COALESCE(name,'')),lower(?))>0)`:'matches AS (SELECT id FROM candidates)'}`;
  const params=[...w.params,...(needle?[needle,needle]:[])];
  return store.readSnapshot(()=>{
    const total=Number(executor.one(scope+' SELECT COUNT(*) n FROM matches',params)!.n);
    const ids=executor.all(scope+' SELECT id FROM matches ORDER BY id LIMIT ? OFFSET ?',[...params,limit,offset]).map(row=>String(row.id));
    return {items:localProjectLabels(store,ids),total,limit,offset};
  });
}

/** Page results and selected filters are enough for display; do not hydrate scope directories. */
export function localResponseProjectIds(route:string,data:unknown,selected?:string,groupBy?:string):string[] {
  const ids=new Set<string>(selected===undefined?[]:[selected]);
  if(['scope','scope-summary','overview','filters','project-labels','project-options'].includes(route))return [...ids];
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const row of value)visit(row);return;}
    const row=value as Record<string,unknown>;
    if(typeof row.project==='string')ids.add(row.project);
    if((route==='breakdown'&&groupBy==='project'||route==='compare'&&(!groupBy||groupBy==='project'))&&typeof row.key==='string')ids.add(row.key);
    for(const [key,child] of Object.entries(row))if(key!=='meta')visit(child);
  };
  visit(data);return [...ids];
}
