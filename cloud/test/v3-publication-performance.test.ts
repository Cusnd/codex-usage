import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {applyBatch} from '../../modules/sync/apply/apply.js';
import {claimJob} from '../../modules/sync/jobs/jobs.js';
import {sha256} from '../../modules/platform/worker/http.js';
import {stableJson} from '../../modules/contracts/sync.js';
import {normalizeTokens} from '../../modules/usage/normalize.js';
import {currentDevice,receive,receipt} from '../../modules/sync/publication/store.js';
import {hashBytes} from '../../modules/sync/apply/codec.js';
import {SyncTiming} from '../../modules/foundation/timing.js';
import {validUploadBatch} from '../../modules/sync/protocol/validate-upload.js';
import {actor,batch,events} from './performance-fixture';
import {instrumentD1} from './d1-performance';

for(const count of [200,500])it(`publishes ${count} exact events with complete entity versions and changes`,async({task})=>{
  const samples=[];
  for(let round=0;round<6;round++){
    const a=await actor(),b=await batch(a,{timestamp:'2026-09-12T00:00:00.000Z'}),sample=b.records[0];
    b.sources=[];b.records=[];
    const perSource=count/20;
    for(let i=0;i<20;i++){
      const source='source-'+i,context={...sample.context,thread_id:'thread-'+i};
      b.sources.push({...((await batch(a,{source})).sources[0]),context,context_hash:await sha256(stableJson(context)),to_cursor:perSource*100,snapshot_eof:perSource*100});
      for(let j=0;j<perSource;j++){
        const n=i*perSource+j;
        b.records.push({...sample,source_id:source,context,locator:j*100,byte_end:(j+1)*100,observation_id:await sha256(stableJson([a.collector,source,1,j*100])),record:{...sample.record!,payload:{...sample.record!.payload,thread_id:context.thread_id,response_id:'response-'+n,usage:normalizeTokens({input_tokens:'9007199254740994',output_tokens:'7',total_tokens:'9007199254741001'})}}});
      }
    }
    b.records_hash=await sha256(stableJson(b.records));expect(validUploadBatch(b)).toBe(true);
    const raw=stableJson(b),wire=gzipSync(raw);expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(1024*1024);
    await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
    const measured=instrumentD1(env.DB),timing=new SyncTiming(),start=performance.now();
    const job=await claimJob(measured.db,a.user,'apply:'+b.batch_id);
    expect(await applyBatch(measured.db,a.user,b,job!,undefined,timing)).toBe(true);
    const elapsed_ms=performance.now()-start,rows=await events(a);
    expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
    expect(rows).toHaveLength(count);
    expect(rows.every(r=>r.total_tokens==='9007199254741001'&&r.input_tokens==='9007199254740994'&&r.output_tokens==='7')).toBe(true);
    expect(new Set(rows.map(r=>r.thread_id)).size).toBe(20);
    const aggregateRaw=await env.DB.prepare('SELECT payload FROM v3_aggregates WHERE user_id=? AND aggregate_key=?').bind(a.user,'["all"]').first<string>('payload');
    const aggregate=JSON.parse(aggregateRaw!);
    expect(aggregate.events).toBe(count);expect(aggregate.thread_count).toBe(20);expect(aggregate.turn_count).toBe(20);
    expect(aggregate.sums.total_tokens).toBe((9007199254741001n*BigInt(count)).toString());
    expect(aggregate.known.cached_input_tokens).toBe(0);
    const versions=(await env.DB.prepare('SELECT kind,entity_id,revision,hash,payload FROM v3_entity_versions WHERE user_id=? AND valid_to IS NULL ORDER BY kind,entity_id').bind(a.user).all<{kind:string;entity_id:string;revision:number;hash:string;payload:string}>()).results;
    expect(versions.filter(r=>r.kind==='event')).toHaveLength(count);
    const eventById=new Map(rows.map(r=>[r.event_id,stableJson(r)]));
    for(const v of versions){expect(v.hash).toBe(await sha256(v.payload));if(v.kind==='event')expect(v.payload).toBe(eventById.get(v.entity_id));}
    const changes=(await env.DB.prepare('SELECT kind,entity_id,revision,hash,payload FROM v3_changes WHERE user_id=? ORDER BY kind,entity_id').bind(a.user).all()).results;
    expect(changes).toEqual(versions);
    expect(await env.DB.prepare('SELECT entity_count FROM v3_commits WHERE user_id=?').bind(a.user).first('entity_count')).toBe(versions.length);
    // Normalize random identities only in this cross-run artifact fingerprint, never in stored values.
    const exactOutput=stableJson(rows).replaceAll(a.device,'<device>').replaceAll(a.collector,'<collector>');
    const canonicalFingerprint=await sha256(exactOutput.replace(/"selected_observation_id":"[a-f0-9]+"/g,'"selected_observation_id":"<observation>"').replace(/"source_project_id":"pc1:[a-f0-9]+"/g,'"source_project_id":"<project>"'));
    samples.push({round,warmup:round===0,elapsed_ms,...measured.stats,timing:timing.header(),entity_count:versions.length,aggregate,canonical_fingerprint:canonicalFingerprint,trace:round===1?measured.trace:undefined});
  }
  expect(new Set(samples.map(s=>s.canonical_fingerprint)).size).toBe(1);
  Object.assign(task.meta,{publicationBenchmark:{count,samples}});
},120000);
