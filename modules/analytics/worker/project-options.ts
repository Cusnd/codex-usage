import type {Page,ProjectLabel} from '../../contracts/responses.js';
import type {QueryFilter,Statement} from '../query-engine.js';
import {where} from '../filter.js';
import {projectLabels} from '../../organization/worker/project-identities.js';

/** Stable identity order keeps paging independent of mutable names and client-side directories. */
export function* projectOptions(filter:QueryFilter,q:string,limit:number,offset:number):Generator<Statement,Page<ProjectLabel>,any>{
  const f:QueryFilter={...filter,project:undefined,unknown:filter.unknown==='project'?undefined:filter.unknown,unknowns:filter.unknowns?.filter(key=>key!=='project'),qProjects:undefined};
  const w=where(f),params=q?[q,q,q,q,q]:[];
  const search=q?`matched_sources AS MATERIALIZED (
      SELECT source_id FROM project_membership WHERE instr(lower(source_id),lower(?))>0 OR instr(lower(COALESCE(source_name,'')),lower(?))>0 OR instr(lower(COALESCE(source_root,'')),lower(?))>0
      UNION SELECT json_extract(payload,'$.source_project_id') FROM versions WHERE kind='thread' AND instr(lower(COALESCE(json_extract(payload,'$.title'),'')),lower(?))>0),
    matched_projects AS MATERIALIZED (SELECT id FROM logical_projects WHERE instr(lower(COALESCE(name,'')||' '||id),lower(?))>0 UNION SELECT logical_id id FROM project_membership WHERE source_id IN(SELECT source_id FROM matched_sources)),`:'';
  const scope=`WITH ${search}options AS (SELECT DISTINCT project id FROM effective_events ${w.sql||'WHERE 1=1'} AND project IS NOT NULL ${q?'AND project IN(SELECT id FROM matched_projects)':''})`;
  const rows:{id:string;total:number}[]=yield {sql:scope+' SELECT id,COUNT(*) OVER() total FROM options ORDER BY id LIMIT ? OFFSET ?',params:[...params,...w.params,limit,offset]};
  const total=rows.length?Number(rows[0].total):Number((yield {sql:scope+' SELECT COUNT(*) n FROM options',params:[...params,...w.params],one:true})?.n||0);
  return {items:yield* projectLabels(rows.map(row=>row.id)),total,limit,offset};
}
