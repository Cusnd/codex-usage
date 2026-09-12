import { type Statement } from "../query-engine.js";
import { fail } from "../../platform/worker/http.js";
import { getRead } from "../../sync/reads/snapshots.js";

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
