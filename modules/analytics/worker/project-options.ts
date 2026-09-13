import type {Page,ProjectLabel} from '../../contracts/responses.js';
import type {QueryFilter,Statement} from '../query-engine.js';
import {where} from '../filter.js';
import {projectLabels} from '../../organization/worker/project-identities.js';

/** SQL finds possible matches; the shared display resolver decides which title is actually shown. */
function* searchedOptions(filter:QueryFilter,q:string,limit:number,offset:number):Generator<Statement,Page<ProjectLabel>,any>{
  const w=where(filter);
  const rows:{id:string;identityMatch:number;metadataMatch:number}[]=yield {sql:`WITH option_search AS (SELECT lower(?) q),
    option_sources AS MATERIALIZED (
      SELECT json_extract(payload,'$.id') source_id,json_extract(payload,'$.logical_project_id') logical_id,
        json_extract(payload,'$.kind') source_kind,json_extract(payload,'$.name') source_name,json_extract(payload,'$.root') source_root
      FROM versions WHERE kind='project' AND json_extract(payload,'$.subtype')='source'),
    option_threads AS MATERIALIZED (
      SELECT entity_id id,json_extract(payload,'$.source_project_id') source_id,json_extract(payload,'$.title') title
      FROM versions WHERE kind='thread'),
    candidates AS (
      SELECT id,instr(lower(id),q)>0 identityMatch,0 metadataMatch FROM logical_projects CROSS JOIN option_search
      WHERE instr(lower(id),q)>0 OR instr(lower(COALESCE(name,'')),q)>0
      UNION ALL
      SELECT logical_id,1,0 FROM option_sources CROSS JOIN option_search WHERE instr(lower(source_id),q)>0
      UNION ALL
      SELECT logical_id,0,1 FROM option_sources CROSS JOIN option_search
      WHERE source_kind<>'session' AND (instr(lower(COALESCE(source_name,'')),q)>0 OR instr(lower(COALESCE(source_root,'')),q)>0)
      UNION ALL
      SELECT s.logical_id,instr(lower(t.id),q)>0,0 FROM option_threads t JOIN option_sources s ON s.source_id=t.source_id CROSS JOIN option_search
      WHERE instr(lower(t.id),q)>0 OR instr(lower(COALESCE(t.title,'')),q)>0 OR instr(lower('会话 '||substr(t.id,1,8)),q)>0
      UNION ALL
      SELECT logical_id,0,0 FROM option_sources WHERE source_kind='session'
        AND source_id NOT IN(SELECT source_id FROM option_threads WHERE source_id IS NOT NULL)),
    options AS (SELECT DISTINCT project id FROM effective_events ${w.sql||'WHERE 1=1'} AND project IS NOT NULL)
    SELECT options.id,MAX(identityMatch) identityMatch,MAX(metadataMatch) metadataMatch
    FROM options JOIN candidates ON candidates.id=options.id GROUP BY options.id ORDER BY options.id`,params:[q,...w.params]};
  // Missing thread entities remain candidates because their displayed fallback uses versioned event IDs.
  // Only candidate identities are resolved; q='' keeps the ordinary SQL pagination path below.
  const matches=new Map(rows.map(row=>[row.id,row])),needle=q.toLowerCase();
  const labels=(yield* projectLabels(rows.map(row=>row.id))).filter(label=>{
    const match=matches.get(label.id)!;
    return label.name.toLowerCase().includes(needle)||!!match.identityMatch||(label.kind!=='session'&&!!match.metadataMatch);
  });
  return {items:labels.slice(offset,offset+limit),total:labels.length,limit,offset};
}

/** Stable identity order keeps paging independent of mutable names and client-side directories. */
export function* projectOptions(filter:QueryFilter,q:string,limit:number,offset:number):Generator<Statement,Page<ProjectLabel>,any>{
  const f:QueryFilter={...filter,project:undefined,unknown:filter.unknown==='project'?undefined:filter.unknown,unknowns:filter.unknowns?.filter(key=>key!=='project'),qProjects:undefined};
  if(q)return yield* searchedOptions(f,q,limit,offset);
  const w=where(f),scope=`WITH options AS (SELECT DISTINCT project id FROM effective_events ${w.sql||'WHERE 1=1'} AND project IS NOT NULL)`;
  const rows:{id:string;total:number}[]=yield {sql:scope+' SELECT id,COUNT(*) OVER() total FROM options ORDER BY id LIMIT ? OFFSET ?',params:[...w.params,limit,offset]};
  const total=rows.length?Number(rows[0].total):Number((yield {sql:scope+' SELECT COUNT(*) n FROM options',params:w.params,one:true})?.n||0);
  return {items:yield* projectLabels(rows.map(row=>row.id)),total,limit,offset};
}
