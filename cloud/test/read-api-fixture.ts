import {env} from 'cloudflare:workers';
import {actor} from './performance-fixture.js';
import {domain} from '../../modules/sync/publication/store.js';
export async function fixture(count:number){
  const a=await actor(),h=await domain(env.DB,a.user),threads=count/10,projects=threads/5+32;
  const src=(n:string)=>`CASE WHEN (${n})%5=0 THEN 's'||(${n}) ELSE 'p'||((${n})%40) END`;
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(a.user),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,payload)
      SELECT ?,?,'thread','t'||v,1,1,'fixture','t'||v,json_object('id','t'||v,'title','Session title '||v,'source_project_id',${src('v')}) FROM n`).bind(threads-1,a.user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?),
      s(id) AS(SELECT DISTINCT ${src('v')} FROM n)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload)
      SELECT ?,?,'project','source:'||id,1,1,'fixture',json_object('subtype','source','id',id,'logical_project_id','l:'||id,'kind',CASE WHEN substr(id,1,1)='s' THEN 'session' ELSE 'app' END,'name',CASE WHEN substr(id,1,1)='s' THEN NULL ELSE 'Project '||id END,'root','/fixture/'||id) FROM s`).bind(threads-1,a.user,h.active_epoch),
    env.DB.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload)
      SELECT user_id,epoch,'project','logical:'||json_extract(payload,'$.logical_project_id'),1,1,'fixture',json_object('subtype','logical','id',json_extract(payload,'$.logical_project_id'),'project',json_object('id',json_extract(payload,'$.logical_project_id'),'name',json_extract(payload,'$.name'),'members',json_array(json_extract(payload,'$.id')),'manual',json('false'),'anchorIds',json('[]')))
      FROM v3_entity_versions WHERE user_id=? AND epoch=? AND kind='project'`).bind(a.user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?),
      e AS(SELECT v,'t'||(v%${threads}) thread,${src('v%'+threads)} source,strftime('%Y-%m-%dT%H:%M:%fZ',1672531200+CAST(v*116640000.0/${count} AS INTEGER),'unixepoch') at FROM n)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,at,origin_device_id,payload)
      SELECT ?,?,'event','e'||v,1,1,'fixture',thread,at,?,json_object('event_id','e'||v,'thread_id',thread,'turn_id','turn'||v,'at',at,'source_project_id',source,'model','model'||(v%3),'effort','high','kind','record','input_tokens','800','cached_input_tokens','200','cache_write_input_tokens','0','output_tokens','200','reasoning_output_tokens','100','total_tokens','1000','service_tier','standard','service_tier_source','record','incomplete',0) FROM e`).bind(count-1,a.user,h.active_epoch,a.device),
  ]);
  return {a,h,threads,projects};
}
