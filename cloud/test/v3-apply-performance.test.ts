import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {applyBatch} from '../src/v3/apply';
import {claimJob} from '../src/v3/jobs';
import {sha256} from '../src/http';
import {stableJson} from '../../shared/sync-v3';
import {normalizeTokens} from '../../shared/usage-domain/normalize';
import {currentDevice,receive,receipt} from '../src/v3/store';
import {hashBytes} from '../src/v3/codec';
import {actor,batch,events} from './performance-fixture';function instrument(base:D1Database) {
  const stats={requests:0,statements:0,rows_read:0,rows_written:0};
  const add=(results:D1Result[])=>{for(const r of results){stats.rows_read+=r.meta.rows_read||0;stats.rows_written+=r.meta.rows_written||0;}};
  const originals=new WeakMap<object,D1PreparedStatement>();
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,key){
      if(key==='bind')return (...args:unknown[])=>wrap(target.bind(...args));
      if(key==='first')return async(column?:string)=>{stats.requests++;stats.statements++;const result=await target.all();add([result]);return column?result.results[0]?.[column]??null:result.results[0]??null;};
      if(key==='all'||key==='run')return async()=>{stats.requests++;stats.statements++;const result=await target.all();add([result]);return result;};
      return Reflect.get(target,key);
    }});originals.set(proxy,statement);return proxy;
  };
  const db=new Proxy(base,{get(target,key){if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql));if(key==='batch')return async(statements:D1PreparedStatement[])=>{stats.requests++;stats.statements+=statements.length;const result=await target.batch(statements.map(s=>originals.get(s)||s));add(result);return result;};return Reflect.get(target,key);}});
  return {db,stats};
}
it('batches preserved origin ownership reads and retains 200 exact records',async()=>{
  const a=await actor(),b=await batch(a);b.records=[];b.sources=[];
  for(let i=0;i<20;i++){
    const one=await batch(a,{source:'source-'+i}),context={...one.sources[0].context,thread_id:'thread-'+i};
    b.sources.push({...one.sources[0],context,context_hash:await sha256(stableJson(context)),to_cursor:1000,snapshot_eof:1000});
    for(let j=0;j<10;j++){const n=i*10+j,r=one.records[0];b.records.push({...r,context,locator:j*100,byte_end:(j+1)*100,observation_id:await sha256(stableJson([a.collector,'source-'+i,1,j*100])),record:{...r.record!,payload:{...r.record!.payload,thread_id:context.thread_id,response_id:'response-'+n,usage:normalizeTokens({total_tokens:'9007199254740994'})}}});}
  }
  for(const r of b.records)r.origin={kind:'preserved',device_id:a.device};b.records_hash=await sha256(stableJson(b.records));const wire=gzipSync(stableJson(b));
  await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
  const {db,stats}=instrument(env.DB),start=performance.now();const job=await claimJob(db,a.user,'apply:'+b.batch_id);await applyBatch(db,a.user,b,job!);
  const elapsed_ms=performance.now()-start,rows=await events(a);
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
  expect(rows).toHaveLength(200);expect(rows.every(r=>r.total_tokens==='9007199254740994')).toBe(true);
  expect(new Set(rows.map(r=>r.thread_id)).size).toBe(20);
  expect(stats.requests).toBeLessThanOrEqual(15);expect(stats.rows_written).toBeLessThan(6000);
},120000);