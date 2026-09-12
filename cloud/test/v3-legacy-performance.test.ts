import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { legacyStep,prepareHandoff } from '../src/v3/legacy';
import { claimJob } from '../src/v3/jobs';
import { domain,currentDevice,guard,endGuard } from '../src/v3/store';
import { stableJson,validUploadBatch,type UploadBatch } from '../../shared/sync-v3';

const at='2026-09-12T00:00:00.000Z';
async function seed(heads:number,records:number,user='legacy-perf',device='legacy-device',start=0) {
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,0) ON CONFLICT DO NOTHING').bind(user,user,user).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,0) ON CONFLICT DO NOTHING').bind(device,user,device,device).run();
  for(let i=start;i<start+heads;i++){
    const thread={id:'thread-'+i.toString().padStart(4,'0'),title:'Legacy '+i,titleUpdatedAt:null,project:'/legacy/'+i%3,source:'cli',parentId:null,subagentParentId:null,forkedFromId:null};
    const manifest={schemaVersion:2,datasetId:'dataset',thread,revision:1,parserVersion:1,collectedAt:at,eventCount:records,chunkCount:1,contentHash:'0'.repeat(64)};
    await env.DB.batch([
      env.DB.prepare('INSERT INTO usage_revisions(user_id,device_id,dataset_id,thread_id,revision,parser_version,collected_at,manifest,received_at,committed) VALUES(?,?,\'dataset\',?,1,1,?,?,0,1)').bind(user,device,thread.id,at,stableJson(manifest)),
      env.DB.prepare(`INSERT INTO usage_records(user_id,device_id,dataset_id,thread_id,revision,event_key,turn_id,response_id,at,project,model,kind,incomplete,input_tokens,output_tokens,total_tokens) SELECT ?,?,'dataset',?,1,value,'turn-'||value,'response-'||?||'-'||value,?,?,'gpt-5','record',0,'9007199254740993',1,'9007199254740994' FROM json_each(?)`).bind(user,device,thread.id,thread.id,at,thread.project,stableJson(Array.from({length:records},(_,j)=>'event-'+j.toString().padStart(4,'0')))),
      env.DB.prepare('INSERT INTO usage_heads(user_id,device_id,dataset_id,thread_id,revision) VALUES(?,?,\'dataset\',?,1)').bind(user,device,thread.id),
    ]);
  }
  await domain(env.DB,user);return {user,device};
}
function instrument(base:D1Database) {
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
async function drain(user:string,db=env.DB){let steps=0;for(;steps<2000;steps++){const job=await claimJob(db,user,'legacy-migrate');if(!job)return steps;await legacyStep(db,job);}throw Error('legacy migration did not finish');}

for(const heads of [10,20])it(`measures complete legacy migration with ${heads} heads and exact integers`,async({annotate,task})=>{
  const {user}=await seed(heads,10),{db,stats}=instrument(env.DB),started=performance.now(),steps=await drain(user,db),elapsed_ms=performance.now()-started,h=await domain(env.DB,user);
  const values=(await env.DB.prepare('SELECT event_id,payload FROM v3_events WHERE user_id=? AND epoch=? ORDER BY event_id').bind(user,h.active_epoch).all<{event_id:string;payload:string}>()).results;
  expect(values).toHaveLength(heads*10);expect(values.every(v=>JSON.parse(v.payload).total_tokens==='9007199254740994')).toBe(true);
  expect(values.reduce((sum,v)=>sum+BigInt(JSON.parse(v.payload).total_tokens),0n)).toBe(BigInt(heads*10)*9007199254740994n);
  expect(h).toMatchObject({mode:'ready',legacy_baseline_pending:0});
  expect(steps).toBeLessThan(20);expect(stats.requests).toBeLessThan(120);
  const sample={heads,records:heads*10,steps,elapsed_ms,...stats};Object.assign(task.meta,{performance:sample});
  await annotate(JSON.stringify(sample),'performance');
},120000);

async function currentEvents(user:string){return (await env.DB.prepare('SELECT event_id,payload FROM v3_events WHERE user_id=? AND epoch=(SELECT active_epoch FROM v3_sync_domains WHERE user_id=?) ORDER BY event_id').bind(user,user).all<{event_id:string;payload:string}>()).results;}
async function untilPhase(user:string,phase:string){for(let i=0;i<100;i++){const job=await claimJob(env.DB,user,'legacy-migrate');expect(job).not.toBeNull();if(JSON.parse(job!.checkpoint).phase===phase)return job!;await legacyStep(env.DB,job!);}throw Error('phase not reached');}

it('publishes a complete multi-device snapshot once and never exposes another user or duplicate response copy',async()=>{
  const {user}=await seed(3,2);await seed(3,2,user,'second-device');const other=await seed(1,2,'other-user','other-device');
  const old=await domain(env.DB,user),job=await untilPhase(user,'events');
  expect(await currentEvents(user)).toEqual([]);expect((await domain(env.DB,user)).active_epoch).toBe(old.active_epoch);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_rebuild_candidates WHERE user_id=?').bind(user).first('n')).toBe(12);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_legacy_heads WHERE user_id=?').bind(user).first('n')).toBe(0);
  await legacyStep(env.DB,job);await drain(user);
  expect(await currentEvents(user)).toHaveLength(6);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_candidates WHERE user_id=?').bind(user).first('n')).toBe(12);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_legacy_heads WHERE user_id=? AND imported_revision=1').bind(user).first('n')).toBe(6);
  expect(await currentEvents(other.user)).toEqual([]);await drain(other.user);expect(await currentEvents(other.user)).toHaveLength(2);
});

it('resumes record pages after an expired lease and rejects an already used lease without duplicate rows',async()=>{
  const {user}=await seed(2,201),job=await untilPhase(user,'import');await legacyStep(env.DB,job);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_rebuild_candidates WHERE user_id=?').bind(user).first('n')).toBe(200);
  await expect(legacyStep(env.DB,job)).rejects.toThrow(/CHECK constraint failed/);
  const abandoned=await claimJob(env.DB,user,'legacy-migrate');expect(abandoned).not.toBeNull();
  await env.DB.prepare('UPDATE v3_jobs SET lease_until=0 WHERE user_id=? AND job_id=?').bind(user,'legacy-migrate').run();
  await drain(user);expect(await currentEvents(user)).toHaveLength(402);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_rebuild_candidates WHERE user_id=?').bind(user).first('n')).toBe(0);
});

it('adopts an old deployed per-head checkpoint while retaining its already imported history',async()=>{
  const {user,device}=await seed(1,3);await drain(user);const first=await currentEvents(user),old=await domain(env.DB,user);
  await seed(2,3,user,device,1);let job=await untilPhase(user,'events');
  await env.DB.prepare('UPDATE v3_jobs SET payload=? WHERE user_id=? AND job_id=?').bind(stableJson({head:{device_id:device,dataset_id:'dataset',thread_id:'thread-0001',revision:1},project_id:null,project_name:null}),user,'legacy-migrate').run();
  job={...job,payload:stableJson({head:{device_id:device,dataset_id:'dataset',thread_id:'thread-0001',revision:1}})};
  await legacyStep(env.DB,job);expect(await currentEvents(user)).toEqual(first);expect((await domain(env.DB,user)).active_epoch).toBe(old.active_epoch);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_legacy_heads WHERE user_id=? AND imported_revision=1').bind(user).first('n')).toBe(1);
  await drain(user);expect(await currentEvents(user)).toHaveLength(9);
});

it('restarts only unpublished work when a v2 head changes or a new earlier head arrives before publication',async()=>{
  const {user,device}=await seed(2,3,'legacy-perf','legacy-device',1);const job=await untilPhase(user,'publish');
  const old=await env.DB.prepare('SELECT manifest FROM usage_revisions WHERE user_id=? AND thread_id=?').bind(user,'thread-0001').first<string>('manifest'),manifest={...JSON.parse(old!),revision:2};
  await env.DB.batch([
    env.DB.prepare('INSERT INTO usage_revisions(user_id,device_id,dataset_id,thread_id,revision,parser_version,collected_at,manifest,received_at,committed) VALUES(?,?,\'dataset\',\'thread-0001\',2,1,?,?,0,1)').bind(user,device,at,stableJson(manifest)),
    env.DB.prepare(`INSERT INTO usage_records(user_id,device_id,dataset_id,thread_id,revision,event_key,turn_id,response_id,at,project,model,kind,incomplete,input_tokens,output_tokens,total_tokens) SELECT user_id,device_id,dataset_id,thread_id,2,event_key,turn_id,response_id,at,project,model,kind,incomplete,6,1,7 FROM usage_records WHERE user_id=? AND thread_id='thread-0001' AND revision=1`).bind(user),
    env.DB.prepare("UPDATE usage_heads SET revision=2 WHERE user_id=? AND thread_id='thread-0001'").bind(user),
  ]);
  await seed(1,3,user,device,0);await legacyStep(env.DB,job);expect(await currentEvents(user)).toEqual([]);expect((await domain(env.DB,user)).legacy_baseline_pending).toBe(1);
  await drain(user);const events=await currentEvents(user);expect(events).toHaveLength(9);expect(events.filter(e=>e.event_id.includes('thread-0001')).every(e=>JSON.parse(e.payload).total_tokens==='7')).toBe(true);
  expect(await env.DB.prepare("SELECT imported_revision FROM v3_legacy_heads WHERE user_id=? AND thread_id='thread-0001'").bind(user).first('imported_revision')).toBe(2);
});

it('materializes 219 synthetic heads and 19,272 records in one resumable baseline',async({task})=>{
  const {user}=await seed(219,88),{db,stats}=instrument(env.DB),started=performance.now(),steps=await drain(user,db),elapsed_ms=performance.now()-started,events=await currentEvents(user);
  expect(events).toHaveLength(19272);expect(events.reduce((sum,e)=>sum+BigInt(JSON.parse(e.payload).total_tokens),0n)).toBe(19272n*9007199254740994n);
  expect(steps).toBeLessThan(320);expect(stats.rows_read).toBeLessThan(1_500_000);Object.assign(task.meta,{performance:{heads:219,records:19272,steps,elapsed_ms,...stats}});
},180000);

for(const heads of [1,500])it(`prepares a legal handoff with ${heads} heads and 500 replacement sources`,async({task})=>{
  const {user,device}=await seed(heads,0),collector='replacement-collector',sources=Array.from({length:500},(_,i)=>({source_id:'replacement-'+i,generation:1,thread_id:'thread-'+(heads===1?0:i).toString().padStart(4,'0')}));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,0)').bind(user,collector,device),
    env.DB.prepare(`INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,cursor,snapshot_eof,context_hash,context,active,complete,available,trailing_bytes) SELECT ?,?,json_extract(value,'$.source_id'),1,'session',0,0,?,json_object('thread_id',json_extract(value,'$.thread_id')),0,1,1,0 FROM json_each(?)`).bind(user,collector,'0'.repeat(64),stableJson(sources)),
  ]);
  const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:1,collector_id:collector,producer_epoch:'handoff',lane:'backfill',lane_seq:1,batch_id:'handoff',records_hash:'0'.repeat(64),sources:[],records:[],metadata:Array.from({length:heads},(_,i)=>({type:'legacy_replacement' as const,dataset_id:'dataset',thread_id:'thread-'+i.toString().padStart(4,'0'),sources:sources.filter(s=>heads===1||s.thread_id==='thread-'+i.toString().padStart(4,'0')).map(({source_id,generation})=>({source_id,generation}))}))};
  expect(validUploadBatch(batch)).toBe(true);const h=await domain(env.DB,user),deviceRow=await currentDevice(env.DB,user,device),{db,stats}=instrument(env.DB),result=await prepareHandoff(db,h,deviceRow,batch);
  Object.assign(task.meta,{performance:{heads,sources:500,read_statements:stats.statements,write_statements:result.statements.length}});
  expect(stats.statements).toBeLessThanOrEqual(4);expect(result.statements.length).toBeLessThanOrEqual(20);
  expect(result.outcomes).toHaveLength(heads);expect(result.outcomes.every(o=>o.status==='applied')).toBe(true);expect(result.plans).toHaveLength(heads+500);
  const op=crypto.randomUUID();await env.DB.batch([guard(env.DB,h,op,deviceRow),...result.statements,endGuard(env.DB,user,op)]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_sources WHERE user_id=? AND collector_id=? AND active=1').bind(user,collector).first('n')).toBe(500);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_legacy_heads WHERE user_id=? AND retired_revision=1').bind(user).first('n')).toBe(heads);
},120000);
