import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {sha256} from '../src/http';
import {advanceJobs} from '../src/v3/jobs';
import {currentDevice,receive,receipt} from '../src/v3/store';
import {hashBytes} from '../src/v3/codec';
import {queryBudget,QueryBudgetExhausted} from '../src/v3/query-budget';
import {stableJson,validUploadBatch,type UploadBatch} from '../../shared/sync-v3';
import {actor,batch} from './performance-fixture';

function counted(base:D1Database) {
  const stats={queries:0,calls:0},originals=new WeakMap<object,D1PreparedStatement>();
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,key){
      if(key==='bind')return (...args:unknown[])=>wrap(target.bind(...args));
      if(['first','all','run','raw'].includes(String(key)))return (...args:unknown[])=>{stats.queries++;stats.calls++;return (Reflect.get(target,key) as Function).apply(target,args);};
      return Reflect.get(target,key);
    }});originals.set(proxy,statement);return proxy;
  };
  return {stats,db:new Proxy(base,{get(target,key){
    if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql));
    if(key==='batch')return (statements:D1PreparedStatement[])=>{stats.queries+=statements.length;stats.calls++;return target.batch(statements.map(s=>originals.get(s)||s));};
    return Reflect.get(target,key);
  }})};
}
async function receiveBatch(a:Awaited<ReturnType<typeof actor>>,b:UploadBatch){
  b.records_hash=await sha256(stableJson(b.records));expect(validUploadBatch(b)).toBe(true);
  const raw=stableJson(b);expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024*1024);
  const wire=gzipSync(raw);await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
}
it('applies the legal maximum of 500 title records',async({task})=>{
  const a=await actor(),b=await batch(a),sample=b.records[0];
  b.sources[0]={...b.sources[0],kind:'titles',to_cursor:50000,snapshot_eof:50000};
  b.records=await Promise.all(Array.from({length:500},async(_,i)=>({...sample,observation_id:await sha256(stableJson([a.collector,'source',1,i*100])),locator:i*100,byte_end:(i+1)*100,record:{type:'session_title',payload:{id:'title-'+i,thread_name:'Title '+i,updated_at:'2026-09-12T00:00:00.000Z'}}})));
  await receiveBatch(a,b);const measured=counted(env.DB),start=performance.now();
  const result=await advanceJobs(measured.db,{user:a.user,maxSteps:1,maxQueries:600,budgetMs:20000});
  Object.assign(task.meta,{measurement:{...measured.stats,elapsed_ms:performance.now()-start}});
  expect(result).toMatchObject({steps:1,queries:measured.stats.queries,budgetExhausted:false});
  expect(measured.stats.queries,JSON.stringify({...measured.stats,elapsed_ms:performance.now()-start})).toBeLessThanOrEqual(600);
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_threads WHERE user_id=?').bind(a.user).first<number>('n')).toBe(500);
  await env.DB.prepare('UPDATE devices SET revoked_at=?,history_deleted_at=? WHERE id=?').bind(Date.now(),Date.now(),a.device).run();
  let complete=false;const deletion=[];
  for(let i=0;i<10;i++){const result=await advanceJobs(env.DB,{user:a.user,maxSteps:200,maxQueries:600,budgetMs:20000});deletion.push(result);expect(result.queries).toBeLessThanOrEqual(600);complete=!(await env.DB.prepare("SELECT 1 FROM v3_jobs WHERE user_id=? AND kind='delete_device' AND state IN('pending','running')").bind(a.user).first());if(complete)break;}
  Object.assign(task.meta,{deletion});expect(complete).toBe(true);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_threads WHERE user_id=?').bind(a.user).first<number>('n')).toBe(0);
},120000);
it('applies 64 complete sources and 500 ordered availability metadata entries',async({task})=>{
  const a=await actor(),b=await batch(a);b.records=[];
  b.sources=Array.from({length:64},(_,i)=>({...b.sources[0],source_id:'source-'+i,to_cursor:0,snapshot_eof:0}));
  b.metadata=Array.from({length:500},(_,i)=>({type:'source_availability',source_id:'source-'+(i%64),available:i%2===0}));
  await receiveBatch(a,b);const measured=counted(env.DB),start=performance.now();
  const result=await advanceJobs(measured.db,{user:a.user,maxSteps:1,maxQueries:600,budgetMs:20000});
  Object.assign(task.meta,{measurement:{...measured.stats,elapsed_ms:performance.now()-start}});
  expect(result.budgetExhausted).toBe(false);
  expect(measured.stats.queries,JSON.stringify({...measured.stats,elapsed_ms:performance.now()-start})).toBeLessThanOrEqual(600);
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
  const replacement={...b,batch_id:crypto.randomUUID(),lane_seq:2,sources:b.sources.map(s=>({...s,generation:2}))};
  await receiveBatch(a,replacement);expect((await advanceJobs(env.DB,{user:a.user,maxSteps:1,maxQueries:600,budgetMs:20000})).budgetExhausted).toBe(false);
  expect((await receipt(env.DB,a.user,replacement.batch_id))?.status).toBe('applied');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_sources WHERE user_id=? AND generation=1').bind(a.user).first<number>('n')).toBe(0);
  const metadata={...b,batch_id:crypto.randomUUID(),lane_seq:3,sources:[],metadata:[...b.metadata,{type:'source_availability' as const,source_id:'source-0',available:false}].slice(1)};
  await receiveBatch(a,metadata);expect((await advanceJobs(env.DB,{user:a.user,maxSteps:1,maxQueries:600,budgetMs:20000})).budgetExhausted).toBe(false);
  expect(await env.DB.prepare('SELECT available FROM v3_sources WHERE user_id=? AND source_id=?').bind(a.user,'source-0').first<number>('available')).toBe(0);
},120000);

it('reserves whole batches, counts failed SQL, and keeps one query for releasing a lease',async()=>{
  const limited=queryBudget(env.DB,5);
  const prepared=limited.db.prepare('SELECT ? value').bind(7);
  expect(limited.stats.queries).toBe(0);
  expect(await prepared.first<number>('value')).toBe(7);
  expect((await limited.db.batch([prepared,prepared])).length).toBe(2);
  expect(limited.stats).toEqual({queries:3,calls:2});
  await expect(limited.db.batch([prepared,prepared])).rejects.toThrow(QueryBudgetExhausted);
  expect(limited.stats.queries).toBe(3);
  await expect(limited.db.prepare('SELECT missing_column FROM users').all()).rejects.toThrow();
  expect(limited.stats.queries).toBe(4);
  await expect(prepared.raw()).rejects.toThrow(QueryBudgetExhausted);
  expect(await limited.releaseDb.prepare('SELECT 1 n').first('n')).toBe(1);
  expect(limited.stats.queries).toBe(5);
  await expect(limited.releaseDb.prepare('SELECT 1').run()).rejects.toThrow(QueryBudgetExhausted);
});

it('yields without changing the pending wire or failure status and resumes with a fresh invocation',async()=>{
  const a=await actor(),b=await batch(a,{tokens:'9007199254740994'});await receiveBatch(a,b);
  const before=await env.DB.prepare('SELECT hex(wire) wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(a.user,b.batch_id).first<string>('wire');
  const measured=counted(env.DB),result=await advanceJobs(measured.db,{user:a.user,maxSteps:200,maxQueries:12,budgetMs:20000});
  expect(result.budgetExhausted).toBe(true);expect(result.queries).toBe(measured.stats.queries);expect(result.queries).toBeLessThanOrEqual(12);
  expect(await env.DB.prepare('SELECT state,lease_token,lease_until,error_code,checkpoint FROM v3_jobs WHERE user_id=? AND job_id=?').bind(a.user,'apply:'+b.batch_id).first()).toEqual({state:'pending',lease_token:null,lease_until:0,error_code:null,checkpoint:'{}'});
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('received');
  expect(await env.DB.prepare('SELECT hex(wire) wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(a.user,b.batch_id).first<string>('wire')).toBe(before);
  expect((await advanceJobs(env.DB,{user:a.user,maxSteps:200,maxQueries:600,budgetMs:20000})).budgetExhausted).toBe(false);
  expect((await receipt(env.DB,a.user,b.batch_id))?.status).toBe('applied');
  expect(await env.DB.prepare('SELECT json_extract(payload,\'$.total_tokens\') n FROM v3_events WHERE user_id=?').bind(a.user).first<string>('n')).toBe('9007199254740994');
});

it('retains the original database failure and its backoff when work uses the last ordinary query',async()=>{
  const a=await actor(),b=await batch(a);await receiveBatch(a,b);const failure=new Error('synthetic D1 failure');
  const faulty=new Proxy(env.DB,{get(target,key){
    if(key==='batch')return ()=>Promise.reject(failure);
    const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
  }});
  // claim + pending input + seven apply reads consume the nine ordinary queries.
  const start=Date.now();await expect(advanceJobs(faulty,{user:a.user,maxSteps:200,maxQueries:25,budgetMs:20000})).rejects.toBe(failure);
  const saved=await env.DB.prepare('SELECT state,lease_token,error_code,next_attempt_at FROM v3_jobs WHERE user_id=? AND job_id=?').bind(a.user,'apply:'+b.batch_id).first<{state:string;lease_token:null;error_code:string;next_attempt_at:number}>();
  expect(saved).toMatchObject({state:'pending',lease_token:null,error_code:'APPLY_FAILED'});expect(saved!.next_attempt_at).toBeGreaterThanOrEqual(start+2000);
});

it('compares 20-step ticks with query-budgeted ticks against the same 100-job queue',async({task})=>{
  const users=Array.from({length:100},()=>crypto.randomUUID()),raw=stableJson(users),now=Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,login,created_at) SELECT value,value,'budget-benchmark',? FROM json_each(?)").bind(now,raw),
    env.DB.prepare('INSERT INTO v3_sync_domains(user_id,active_epoch,updated_at) SELECT value,value,? FROM json_each(?)').bind(now,raw),
    env.DB.prepare("INSERT INTO devices(id,user_id,name,token_hash,bound_at,revoked_at,history_deleted_at) SELECT value,value,'test',value,?,?,? FROM json_each(?)").bind(now,now,now,raw),
    env.DB.prepare("INSERT INTO v3_jobs(user_id,job_id,kind,device_id,payload,created_at,updated_at) SELECT value,'delete:'||value,'delete_device',value,'{}',?,? FROM json_each(?)").bind(now,now,raw),
  ]);
  const run=async(maxSteps:number,maxQueries?:number)=>{
    const ticks=[];let complete=0;
    for(let i=0;i<10&&complete<100;i++){
      const measured=counted(env.DB),start=performance.now(),result=await advanceJobs(measured.db,{maxSteps,maxQueries,budgetMs:20000});
      complete=(await env.DB.prepare("SELECT COUNT(*) n FROM v3_jobs WHERE state='complete'").first<number>('n'))!;
      ticks.push({...result,...measured.stats,elapsed_ms:performance.now()-start,complete});
      if(maxQueries)expect(measured.stats.queries).toBeLessThanOrEqual(maxQueries);
    }
    expect(complete).toBe(100);return ticks;
  };
  const before=await run(20);
  await env.DB.prepare("UPDATE v3_jobs SET state='pending',lease_token=NULL,lease_until=0,next_attempt_at=0,attempts=0,checkpoint='{}'").run();
  const after=await run(200,600);
  Object.assign(task.meta,{benchmark:{workload:'100 independent v3 device deletions; same queue and current algorithm; local D1, no artificial network delay',before,after}});
  expect(after.length).toBeLessThanOrEqual(before.length);
},30000); // Two real 100-job D1 runs; wall time is not the performance assertion.
