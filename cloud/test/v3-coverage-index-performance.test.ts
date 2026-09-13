import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {stableJson} from '../../modules/contracts/sync.js';
import {sha256} from '../../modules/platform/worker/http.js';
import {normalizeTokens} from '../../modules/usage/normalize.js';
import {applyBatch} from '../../modules/sync/apply/apply.js';
import {hashBytes} from '../../modules/sync/apply/codec.js';
import {claimJob} from '../../modules/sync/jobs/jobs.js';
import {currentDevice,receive,receipt} from '../../modules/sync/publication/store.js';
import {validUploadBatch} from '../../modules/sync/protocol/validate-upload.js';
import {actor,batch,events} from './performance-fixture';
import {instrumentD1} from './d1-performance';

const index='v3_candidates_device_coverage';
const createIndex=`CREATE INDEX ${index} ON v3_candidates(user_id,uploader_device_id,at) WHERE active=1`;
const grouped=`WITH coverage AS (SELECT uploader_device_id,MIN(at) coverage_from,MAX(at) coverage_to
  FROM v3_candidates WHERE user_id=? AND active=1 GROUP BY uploader_device_id)
  SELECT d.id,coverage_from,coverage_to FROM devices d LEFT JOIN coverage c ON c.uploader_device_id=d.id WHERE d.user_id=? ORDER BY d.id`;
const boundaries=`SELECT d.id,
  (SELECT MIN(c.at) FROM v3_candidates c WHERE c.user_id=d.user_id AND c.uploader_device_id=d.id AND c.active=1) coverage_from,
  (SELECT MAX(c.at) FROM v3_candidates c WHERE c.user_id=d.user_id AND c.uploader_device_id=d.id AND c.active=1) coverage_to
  FROM devices d WHERE d.user_id=? ORDER BY d.id`;

async function publication(count:number){
  const a=await actor(),b=await batch(a,{timestamp:'2026-09-12T00:00:00.000Z'}),sample=b.records[0],sourceSample=b.sources[0];b.sources=[];b.records=[];
  for(let sourceIndex=0;sourceIndex<20;sourceIndex++){
    const source='source-'+sourceIndex,context={...sample.context,thread_id:'thread-'+sourceIndex},perSource=count/20;
    b.sources.push({...sourceSample,source_id:source,context,context_hash:await sha256(stableJson(context)),to_cursor:perSource*100,snapshot_eof:perSource*100});
    for(let j=0;j<perSource;j++)b.records.push({...sample,source_id:source,context,locator:j*100,byte_end:(j+1)*100,
      observation_id:await sha256(stableJson([a.collector,source,1,j*100])),record:{...sample.record!,payload:{...sample.record!.payload,thread_id:context.thread_id,response_id:'response-'+(sourceIndex*perSource+j),usage:normalizeTokens({input_tokens:'9007199254740994',output_tokens:'7',total_tokens:'9007199254741001'})}}});
  }
  b.records_hash=await sha256(stableJson(b.records));expect(validUploadBatch(b)).toBe(true);
  const wire=gzipSync(stableJson(b));await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
  const measured=instrumentD1(env.DB),started=performance.now(),job=await claimJob(measured.db,a.user,'apply:'+b.batch_id);
  expect(await applyBatch(measured.db,a.user,b,job!)).toBe(true);const elapsed_ms=performance.now()-started;
  const rows=await events(a);expect(rows).toHaveLength(count);expect(rows.every(r=>r.total_tokens==='9007199254741001')).toBe(true);
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
  const aggregate=JSON.parse((await env.DB.prepare("SELECT payload FROM v3_aggregates WHERE user_id=? AND aggregate_key='[\"all\"]'").bind(a.user).first<string>('payload'))!);
  expect(aggregate.sums.total_tokens).toBe((9007199254741001n*BigInt(count)).toString());
  const fingerprint=await sha256(stableJson(rows).replaceAll(a.device,'<device>').replaceAll(a.collector,'<collector>').replace(/"selected_observation_id":"[a-f0-9]+"/g,'"selected_observation_id":"<observation>"').replace(/"source_project_id":"pc1:[a-f0-9]+"/g,'"source_project_id":"<project>"'));
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind(a.user).run();
  return {elapsed_ms,...measured.stats,fingerprint};
}

it('compares a partial coverage index, boundary reads and real publication cost in one isolated D1 fixture',async({task})=>{
  // This experiment can also run after the additive migration is retained.
  // Drop/recreate touches only the isolated local test database.
  await env.DB.prepare(`DROP INDEX IF EXISTS ${index}`).run();
  try {
  const a=await actor(),count=25000;
  await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO v3_candidates(user_id,observation_id,uploader_device_id,collector_id,source_id,generation,record_revision,event_id,thread_id,at,active,candidate)
    SELECT ?,'observation-'||v,?,'collector','source',1,1,'event-'||v,'thread','2026-09-'||printf('%02d',1+(v%28))||'T00:00:00.000Z',CASE WHEN v%5=0 THEN 0 ELSE 1 END,json_object('evidence',printf('%02000d',0)) FROM n`).bind(count-1,a.user,a.device).run();
  const expected=(await env.DB.prepare(boundaries).bind(a.user).all()).results;
  const samples:unknown[]=[],plans:unknown[]=[];
  async function reads(phase:string){
    for(const [name,sql,params] of [['grouped',grouped,[a.user,a.user]],['boundaries',boundaries,[a.user]]] as const){
      plans.push({phase,name,plan:(await env.DB.prepare('EXPLAIN QUERY PLAN '+sql).bind(...params).all()).results});
      for(let round=0;round<6;round++){
        const measured=instrumentD1(env.DB),started=performance.now(),result=await measured.db.prepare(sql).bind(...params).all(),elapsed_ms=performance.now()-started;
        expect(result.results).toEqual(expected);
        if(phase==='with-index'&&name==='boundaries')expect(measured.stats.rows_read).toBeLessThanOrEqual(3);
        samples.push({phase,name,round,warmup:round===0,elapsed_ms,...measured.stats});
      }
    }
  }
  async function writes(phase:string){for(const count of [200,500])for(let round=0;round<6;round++)samples.push({phase,name:'publication-'+count,round,warmup:round===0,...await publication(count)});}
  await reads('without-index');
  const before=(await env.DB.prepare('SELECT 1').all()).meta,indexResult=await env.DB.prepare(createIndex).run(),after=(await env.DB.prepare('SELECT 1').all()).meta;
  await reads('with-index');
  await env.DB.prepare(`DROP INDEX ${index}`).run();await writes('without-index');
  await env.DB.prepare(createIndex).run();await writes('with-index');
  for(const name of ['publication-200','publication-500'])expect(new Set((samples as any[]).filter(s=>s.name===name).map(s=>s.fingerprint)).size).toBe(1);
  Object.assign(task.meta,{coverageIndexPerformance:{count,active:20000,indexSql:createIndex,before_meta:before,index_meta:indexResult.meta,after_meta:after,plans,samples}});
  } finally {
    await env.DB.prepare(createIndex.replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ')).run();
  }
},120000);
