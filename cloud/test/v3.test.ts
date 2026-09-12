import {matchingDevice} from './matching-build';
import {MatchingRequest} from './matching-build';
import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { gzipSync } from 'node:zlib';
import worker from '../../apps/cloud/index.js';
import { SESSION_COOKIE,sha256,token } from '../../modules/platform/worker/http.js';
import { stableJson, V3_CONTENT_TYPE, type UploadBatch } from '../../modules/contracts/sync.js';
import { initialContext,normalizeTokens } from '../../modules/usage/normalize.js';
import { domain,guard,endGuard,currentDevice,receive,receipt,entityStatements } from '../../modules/sync/publication/store.js';
import { metricStatements } from '../../modules/sync/publication/metrics.js';
import { cleanupVersions,entities as readEntities,manifest as readManifest } from '../../modules/sync/reads/snapshots.js';
import { hashBytes } from '../../modules/sync/apply/codec.js';
import { advanceJobs } from '../../modules/sync/jobs/jobs.js';

const origin='https://quota.esoren.com';
type Actor={user:string;session:string;device:string;credential:string;collector:string};
async function actor(user?:string):Promise<Actor>{const id=user||crypto.randomUUID(),session=token(),device=crypto.randomUUID(),credential=token();if(!user)await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'v3-test',Date.now()).run();await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),id,Date.now()+86400000).run();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(device,id,device,await sha256(credential),Date.now()).run();await matchingDevice(env.DB,device);return {user:id,session,device,credential,collector:crypto.randomUUID()};}
async function batch(a:Actor,options:{seq?:number;generation?:number;from?:number;complete?:boolean;response?:string;tokens?:string;originDevice?:string;originKind?:'preserved'|'execution';source?:string;record?:any;timestamp?:string}={}):Promise<UploadBatch>{
  const seq=options.seq||1,generation=options.generation||1,from=options.from||0,context={...initialContext('thread'),turn_id:'turn',model:'gpt-5',cwd:'/project',source_project_id:'project'},source=options.source||'source';
  const record=options.record||{type:'token_usage_record',timestamp:options.timestamp||new Date().toISOString(),payload:{thread_id:'thread',turn_id:'turn',response_id:options.response||'response-a',usage:normalizeTokens({input_tokens:options.tokens||'100',output_tokens:'0',total_tokens:options.tokens||'100'})}};
  const records=[{observation_id:await sha256(stableJson([a.collector,source,generation,from])),record_revision:1,source_id:source,generation,locator:from,byte_end:from+100,prefix_hash:await sha256(stableJson(record)),session_trusted:true,origin:{device_id:options.originDevice||a.device,kind:options.originKind||'execution' as const},context,record}];
  return {protocol:3,schema_version:1,extractor_version:2,collector_id:a.collector,producer_epoch:'epoch',lane:'live',lane_seq:seq,batch_id:crypto.randomUUID(),records_hash:await sha256(stableJson(records)),sources:[{source_id:source,generation,kind:'session',from_cursor:from,to_cursor:from+100,snapshot_eof:from+100,context_hash:await sha256(stableJson(context)),context,replace_start:from===0,replace_end:options.complete!==false,generation_complete:options.complete!==false,available:true,trailing_bytes:0}],records,metadata:[]};
}
async function call(a:Actor,path:string,method='GET',body?:unknown){return worker.fetch(new MatchingRequest(origin+path,{method,headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+a.session,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)}),env);}
async function upload(a:Actor,b:UploadBatch){const wire=gzipSync(stableJson(b));return worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:wire}),env);}
async function apply(a:Actor,b:UploadBatch){const wire=gzipSync(stableJson(b)),device=await currentDevice(env.DB,a.user,a.device);await receive(env.DB,device,b,wire,await hashBytes(wire));await advanceJobs(env.DB,{user:a.user,job_id:'apply:'+b.batch_id,maxSteps:1});return receipt(env.DB,a.user,b.batch_id);}
async function events(a:Actor){return (await env.DB.prepare('SELECT payload FROM v3_events WHERE user_id=? AND epoch=(SELECT active_epoch FROM v3_sync_domains WHERE user_id=?) ORDER BY event_id').bind(a.user,a.user).all<{payload:string}>()).results.map(r=>JSON.parse(r.payload));}
async function drain(a:Actor,steps=80){for(let i=0;i<steps;i++){await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(a.user).run();const result=await advanceJobs(env.DB,{user:a.user,maxSteps:1,budgetMs:10000});if(!result.steps)return; }throw Error('jobs did not finish');}
async function many(a:Actor,start:number,count:number,seq:number,complete:boolean){const b=await batch(a,{seq,from:start*100,complete});b.records=[];for(let i=start;i<start+count;i++){const value=await batch(a,{seq,from:i*100,complete,response:'old-'+i,tokens:'1'});b.records.push(value.records[0]);}b.sources[0].to_cursor=(start+count)*100;b.sources[0].snapshot_eof=(start+count)*100;b.records_hash=await sha256(stableJson(b.records));return b;}
async function authorization(a:Actor){const credential=token(),response=await call(a,'/api/v3/device-authorizations','POST',{deviceName:'Recovered computer',tokenHash:await sha256(credential)});expect(response.status).toBe(201);return {...await response.json<any>(),credential};}
const approve=(a:Actor,p:{userCode:string},target:string|null)=>call(a,'/api/v3/device-authorizations/approve','POST',{code:p.userCode,replaceDeviceId:target});
const poll=(a:Actor,p:{requestId:string;pollSecret:string})=>call(a,'/api/v3/device-authorizations/poll','POST',{requestId:p.requestId,pollSecret:p.pollSecret});
async function unknown(b:UploadBatch){for(const r of b.records)r.origin={kind:'observed_local',device_id:null};b.records_hash=await sha256(stableJson(b.records));return b;}
const origins=(a:Actor)=>call(a,'/api/v3/origins?limit=50').then(r=>r.json<any>());

it.each([null,'Named project'])('project breakdown and comparison label an existing logical project named %s without exposing its ID',async name=>{
  const a=await actor(),b=await batch(a,{timestamp:'2026-09-12T12:00:00Z'});
  b.metadata=[{type:'project',source_project_id:'project',value:{kind:'session',name}}];await apply(a,b);
  for(const route of ['breakdown','compare']){
    const response=await call(a,'/api/v3/usage/local/'+route+'?groupBy=project&from=2026-09-01T00:00:00Z&to=2026-09-20T00:00:00Z');
    expect(response.status).toBe(200);const result=await response.json<any>();expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].key).toMatch(/^lp1:/);expect(result.data.items[0].label).toBe(name||'未命名项目');
  }
});
async function assignOrigins(a:Actor,lease:string,device?:string,id=crypto.randomUUID()){const body={operation_id:id,lease_id:lease,action:device?'assign':'revoke',thread_ids:['thread'],...device?{device_id:device}:{}};return {body,response:await call(a,'/api/v3/origins/operations','POST',body)};}

it('assigns only fixed-cut naturally unknown history, preserves natural proof and tokens, and revokes with idempotent operation IDs',async()=>{
  const a=await actor(),target=await actor(a.user);await upload(a,await unknown(await batch(a,{response:'old',tokens:'100'})));await upload(a,await batch(a,{seq:2,from:100,response:'known',tokens:'7'}));
  const view=await origins(a);expect(view.summary).toEqual({unknown_events:1,assigned_events:0,natural_known_events:1});
  await upload(a,await unknown(await batch(a,{seq:3,from:200,response:'later',tokens:'3'})));
  const action=await assignOrigins(a,view.lease_id,target.device);expect(action.response.status).toBe(200);const done=await action.response.json<any>();expect(done).toMatchObject({status:'complete',affected_events:1});
  const values=await events(a),old=values.find(e=>e.event_id==='response:old');expect(old).toMatchObject({origin_device_id:null,user_assignment:{operation_id:action.body.operation_id,device_id:target.device,label:'用户指定'},total_tokens:'100'});expect(values.find(e=>e.event_id==='response:known')).toMatchObject({origin_device_id:a.device});expect(values.find(e=>e.event_id==='response:later').user_assignment).toBeUndefined();
  const filtered=await (await call(a,'/api/v3/sync/read','POST',{scope:'full',device_ids:[target.device]})).json<any>();expect((await readEntities(env.DB,a.user,filtered.lease_id,[{kind:'event',id:'response:old'}])).entities).toHaveLength(1);expect((await (await call(a,'/api/v3/usage/local/summary?lease_id='+filtered.lease_id)).json<any>()).data.totalTokens).toBe('100');
  expect((await readEntities(env.DB,a.user,view.lease_id,[{kind:'event',id:'response:old'}])).entities[0].value.user_assignment).toBeUndefined();expect((await (await call(a,'/api/v3/origins?lease_id='+view.lease_id)).json<any>()).summary.assigned_events).toBe(0);
  expect(await (await call(a,'/api/v3/origins/operations','POST',action.body)).json()).toEqual(done);expect((await call(a,'/api/v3/origins/operations','POST',{...action.body,device_id:a.device})).status).toBe(409);
  const latest=await origins(a),revoked=await assignOrigins(a,latest.lease_id);expect((await revoked.response.json<any>()).affected_events).toBe(1);expect((await events(a)).every(e=>!e.user_assignment)).toBe(true);expect((await events(a)).reduce((n,e)=>n+BigInt(e.total_tokens),0n)).toBe(110n);
  expect((await readEntities(env.DB,a.user,filtered.lease_id,[{kind:'event',id:'response:old'}])).entities[0].value.user_assignment.device_id).toBe(target.device);
});

it('keeps assignments separate from preserved execution claims and lets newly recovered natural evidence win',async()=>{
  const a=await actor(),target=await actor(a.user),copy=await actor(a.user);await upload(a,await unknown(await batch(a)));const action=await assignOrigins(a,(await origins(a)).lease_id,target.device);expect(action.response.status).toBe(200);
  await upload(copy,await batch(copy,{originKind:'preserved',originDevice:target.device}));expect((await events(a))[0]).toMatchObject({origin_device_id:null,user_assignment:{device_id:target.device}});
  await upload(copy,await batch(copy,{seq:2,generation:2}));expect((await events(a))[0]).toMatchObject({origin_device_id:copy.device});expect((await events(a))[0].user_assignment).toBeUndefined();
  expect((await origins(a)).summary).toEqual({unknown_events:0,assigned_events:0,natural_known_events:1});
});

it('publishes a large assignment as one resumable epoch and preserves the pinned old view and all metadata',async()=>{
  const a=await actor(),target=await actor(a.user);await upload(a,await unknown(await many(a,0,350,1,true)));const view=await origins(a),oldHead=await domain(env.DB,a.user),action=await assignOrigins(a,view.lease_id,target.device);expect(action.response.status).toBe(202);expect((await domain(env.DB,a.user)).active_epoch).toBe(oldHead.active_epoch);
  expect((await events(a)).every(e=>!e.user_assignment)).toBe(true);expect((await call(a,'/api/v3/sync/read','POST',{scope:'full'})).status).toBe(409);
  const job=await env.DB.prepare('SELECT checkpoint FROM v3_jobs WHERE user_id=? AND job_id=?').bind(a.user,'origin:'+action.body.operation_id).first<string>('checkpoint');expect(JSON.parse(job!).selected).toBe(350);
  await drain(a);const done=await (await call(a,'/api/v3/origins/operations/'+action.body.operation_id)).json<any>();expect(done).toMatchObject({status:'complete',affected_events:350});expect(done.cut.dataset_epoch).not.toBe(oldHead.active_epoch);expect(done.cut.commit_seq).toBe(0);
  expect((await events(a)).filter(e=>e.user_assignment?.device_id===target.device)).toHaveLength(350);expect((await readEntities(env.DB,a.user,view.lease_id,[{kind:'event',id:'response:old-0'}])).entities[0].value.user_assignment).toBeUndefined();
  const scoped=await (await call(a,'/api/v3/sync/read','POST',{scope:'full',device_ids:[target.device]})).json<any>();expect((await (await call(a,'/api/v3/usage/local/summary?lease_id='+scoped.lease_id)).json<any>()).data).toMatchObject({totalTokens:'350',threadCount:1});
  const summary=JSON.parse((await env.DB.prepare('SELECT payload FROM v3_aggregates WHERE user_id=? AND epoch=? AND aggregate_key=?').bind(a.user,done.cut.dataset_epoch,stableJson(['device',target.device])).first<string>('payload'))!);expect(summary).toMatchObject({events:350,thread_count:1});
  await upload(a,await unknown(await batch(a,{seq:2,from:35000,response:'future',tokens:'5'})));expect((await events(a)).find(e=>e.event_id==='response:future').user_assignment).toBeUndefined();
});

it('deleting the assigned target withdraws labels but deleting the uploader removes its uploaded history',async()=>{
  const a=await actor(),target=await actor(a.user);await upload(a,await unknown(await batch(a)));await assignOrigins(a,(await origins(a)).lease_id,target.device);
  await call(a,'/api/v3/devices/'+target.device+'/history','DELETE');await drain(a);expect(await events(a)).toHaveLength(1);expect((await events(a))[0]).toMatchObject({origin_device_id:null,total_tokens:'100'});expect((await events(a))[0].user_assignment).toBeUndefined();
  await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');await drain(a);expect(await events(a)).toHaveLength(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_origin_operation_events WHERE user_id=?').bind(a.user).first('n')).toBe(0);expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_origin_operations WHERE user_id=? AND payload<>'{}'").bind(a.user).first('n')).toBe(0);
});

it('retains explicit choices through unknown revisions and revokes only assignments in the selected old cut',async()=>{
  const a=await actor(),target=await actor(a.user);await upload(a,await unknown(await batch(a,{response:'old'})));const first=await assignOrigins(a,(await origins(a)).lease_id,target.device),assigned=await origins(a);
  await upload(a,await unknown(await batch(a,{seq:2,from:100,response:'old',tokens:'101'})));expect((await events(a))[0].user_assignment.operation_id).toBe(first.body.operation_id);
  await upload(a,await unknown(await batch(a,{seq:3,from:200,response:'later',tokens:'3'})));const later=await assignOrigins(a,(await origins(a)).lease_id,target.device);expect((await later.response.json<any>()).affected_events).toBe(1);
  const revoke=await assignOrigins(a,assigned.lease_id);expect((await revoke.response.json<any>()).affected_events).toBe(1);const values=await events(a);expect(values.find(e=>e.event_id==='response:old').user_assignment).toBeUndefined();expect(values.find(e=>e.event_id==='response:later').user_assignment.operation_id).toBe(later.body.operation_id);
  const checkpoint=await origins(a);expect(checkpoint.summary.assigned_events).toBe(1);expect(checkpoint.summary.unknown_events).toBe(1);
});

it('isolates origin operations by user and cancels an unpublished epoch when target history is deleted',async()=>{
  const a=await actor(),target=await actor(a.user),other=await actor();await upload(a,await unknown(await many(a,0,350,1,true)));const view=await origins(a);
  expect((await assignOrigins(a,view.lease_id,other.device)).response.status).toBe(404);expect((await assignOrigins(other,view.lease_id,target.device)).response.status).toBe(409);
  const action=await assignOrigins(a,view.lease_id,target.device);expect(action.response.status).toBe(202);expect((await call(other,'/api/v3/origins/operations/'+action.body.operation_id)).status).toBe(404);
  await call(a,'/api/v3/devices/'+target.device+'/history','DELETE');await drain(a);const saved=await (await call(a,'/api/v3/origins/operations/'+action.body.operation_id)).json<any>();expect(saved.status).toBe('failed');expect((await events(a)).every(e=>!e.user_assignment)).toBe(true);expect(await events(a)).toHaveLength(350);expect((await domain(env.DB,a.user)).mode).toBe('ready');
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_entity_versions v JOIN v3_sync_domains h USING(user_id) WHERE v.user_id=? AND v.epoch<>h.active_epoch").bind(a.user).first('n')).toBe(0);
});
function traceReads(db:D1Database){
  let rows=0;const statement=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(target,key){if(key==='bind')return(...args:unknown[])=>statement(target.bind(...args));if(key==='all')return async()=>{const result=await target.all();rows+=result.meta.rows_read;return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  return {db:new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>statement(target.prepare(sql));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),take(){const value=rows;rows=0;return value;}};
}

it('resolves system timezones per browser at the same saved cut while manual zones stay fixed and malformed zones fail',async()=>{
  const a=await actor();await upload(a,await batch(a,{timestamp:'2026-09-11T00:30:00.000Z'}));await call(a,'/api/v3/settings','PATCH',{timezoneMode:'system',timezone:'UTC'});
  const lease=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();expect(lease.settings).toMatchObject({timezoneMode:'system',timezone:'UTC'});
  const at=(zone:string)=>'lease_id='+lease.lease_id+'&timezone='+encodeURIComponent(zone),west=await (await call(a,'/api/v3/usage/local/trend?'+at('America/Los_Angeles'))).json<any>(),east=await (await call(a,'/api/v3/usage/local/trend?'+at('Asia/Tokyo'))).json<any>();
  expect(west.data).toMatchObject([{time:'2026-09-10',totalTokens:'100'}]);expect(east.data).toMatchObject([{time:'2026-09-11',totalTokens:'100'}]);expect(west.meta.cut).toEqual(lease.cut);expect(east.meta.cut).toEqual(lease.cut);
  const settings=await (await call(a,'/api/v3/settings?'+at('Asia/Tokyo'))).json<any>();expect(settings.data).toMatchObject({timezoneMode:'system',timezone:'Asia/Tokyo'});expect(settings.meta).toMatchObject({timezone:'Asia/Tokyo',cut:lease.cut});
  await call(a,'/api/v3/settings','PATCH',{timezoneMode:'manual',timezone:'UTC'});const manual=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>(),fixed=await (await call(a,'/api/v3/usage/local/trend?lease_id='+manual.lease_id+'&timezone=America%2FLos_Angeles')).json<any>();expect(fixed.meta.timezone).toBe('UTC');expect(fixed.data[0].time).toBe('2026-09-11');expect((await (await call(a,'/api/v3/settings?'+at('America/Los_Angeles'))).json<any>()).data.timezone).toBe('America/Los_Angeles');
  for(const invalid of ['timezone=','timezone=Mars%2FBase','timezone=UTC%2B04','timezone=UTC&timezone=Asia%2FTokyo']){const bad=await call(a,'/api/v3/usage/local/summary?lease_id='+manual.lease_id+'&'+invalid);expect(bad.status).toBe(400);expect(await bad.json()).toMatchObject({error:{code:'INVALID_TIMEZONE'}});}
  expect((await call(a,'/api/v3/settings?lease_id='+lease.lease_id+'&timezone=bad')).status).toBe(400);
});

it('looks up fixed-cut entity keys and late manifest pages without scanning 10k unrelated versions, preserving recent and device scopes',async()=>{
  const a=await actor(),b=await actor(a.user);await upload(a,await batch(a));const h=await domain(env.DB,a.user);
  await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10000) INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,at,thread_id,origin_device_id,payload)
    SELECT ?,?,'event','spare-'||printf('%05d',v),1,1,'synthetic','2000-01-01T00:00:00.000Z',CASE WHEN v=10000 THEN 'thread' ELSE 'old-'||v END,?,json_object('total_tokens','1') FROM n`).bind(a.user,h.active_epoch,b.device).run();
  const full=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>(),recent=await (await call(a,'/api/v3/sync/read','POST',{scope:'recent',device_ids:[b.device]})).json<any>(),onlyB=await (await call(a,'/api/v3/sync/read','POST',{scope:'full',device_ids:[b.device]})).json<any>(),traced=traceReads(env.DB);
  expect((await readEntities(traced.db,a.user,full.lease_id,[{kind:'event',id:'response:response-a'}])).entities[0].value.total_tokens).toBe('100');expect(traced.take(),'one exact entity key').toBeLessThan(1000);
  const page=await readManifest(traced.db,a.user,full.lease_id,btoa(JSON.stringify(['event','spare-09990'])),5);expect(page.entities.map(e=>e.id)).toEqual(['spare-09991','spare-09992','spare-09993','spare-09994','spare-09995']);expect(traced.take(),'late keyset page').toBeLessThan(1000);
  await expect(readEntities(traced.db,a.user,onlyB.lease_id,[{kind:'event',id:'response:response-a'}])).rejects.toMatchObject({code:'ENTITY_OUTSIDE_SCOPE'});expect(traced.take(),'device scope rejection').toBeLessThan(1000);
  await expect(readEntities(traced.db,a.user,recent.lease_id,[{kind:'event',id:'spare-09999'}])).rejects.toMatchObject({code:'ENTITY_OUTSIDE_SCOPE'});expect(traced.take(),'old inactive thread rejection').toBeLessThan(1000);
  expect((await readEntities(traced.db,a.user,recent.lease_id,[{kind:'event',id:'spare-10000'}])).entities[0].value.total_tokens).toBe('1');expect(traced.take(),'old event in a recently active thread').toBeLessThan(1000);
  await upload(a,await batch(a,{seq:2,generation:2,tokens:'7'}));expect((await readEntities(traced.db,a.user,full.lease_id,[{kind:'event',id:'response:response-a'}])).entities[0].value.total_tokens).toBe('100');expect(traced.take(),'old cut after replacement').toBeLessThan(1000);
  await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');await expect(readEntities(traced.db,a.user,full.lease_id,[{kind:'event',id:'response:response-a'}])).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
});

it('collects expired change history with a scalar cutoff while preserving versions pinned by a live lease',async()=>{
  const a=await actor(),now=Date.now();await upload(a,await batch(a));await cleanupVersions(env.DB,now);
  const lease=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();await upload(a,await batch(a,{seq:2,generation:2,response:'replacement',tokens:'7'}));
  await env.DB.prepare('UPDATE v3_commits SET created_at=? WHERE user_id=?').bind(now-8*86400_000,a.user).run();await cleanupVersions(env.DB,now);
  expect((await domain(env.DB,a.user)).changes_floor).toBe(2);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_commits WHERE user_id=?').bind(a.user).first('n')).toBe(0);
  const pinned=await (await call(a,'/api/v3/usage/local/summary?lease_id='+lease.lease_id)).json<any>();expect(pinned.data.totalTokens).toBe('100');expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_entity_versions WHERE user_id=? AND valid_to IS NOT NULL').bind(a.user).first<number>('n')).toBeGreaterThan(0);
  await cleanupVersions(env.DB,now+2*3600_000);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_entity_versions WHERE user_id=? AND valid_to IS NOT NULL').bind(a.user).first('n')).toBe(0);expect((await events(a)).map(e=>e.total_tokens)).toEqual(['7']);
});

it('touches only requested metric members and current entity versions with 10k unrelated historical rows',async()=>{
  const a=await actor();await upload(a,await batch(a));const h=await domain(env.DB,a.user),event=(await events(a))[0];
  await env.DB.batch([
    env.DB.prepare("WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10000) INSERT INTO v3_aggregate_members(user_id,epoch,aggregate_key,kind,member_id,refs) SELECT ?,?,'unrelated','thread','spare-'||v,1 FROM n").bind(a.user,h.active_epoch),
    env.DB.prepare("WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10000) INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) SELECT ?,?,'event','spare-'||v,0,1,'synthetic','{}' FROM n").bind(a.user,h.active_epoch),
  ]);
  let rowsRead=0;const traced=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const results=await target.batch(statements);for(const r of results)rowsRead+=r.meta.rows_read;return results;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const next={...event,event_id:'response:another',thread_id:'another-thread',turn_id:'another-turn'},statements=await metricStatements(traced,h,[{event_id:next.event_id,before:null,after:next}]);expect(rowsRead).toBeLessThan(1000);await env.DB.batch(statements);
  const summary=JSON.parse((await env.DB.prepare('SELECT payload FROM v3_aggregates WHERE user_id=? AND epoch=? AND aggregate_key=?').bind(a.user,h.active_epoch,stableJson(['all'])).first<string>('payload'))!);expect(summary).toMatchObject({events:2,thread_count:2,turn_count:2});
  const changes=await entityStatements(env.DB,h,[{kind:'event',id:event.event_id,revision:2,value:{...event,total_tokens:'7'}}]),written=await env.DB.batch(changes);expect(written[1].meta.rows_read).toBeLessThan(1000);expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_entity_versions WHERE user_id=? AND epoch=? AND entity_id LIKE 'spare-%' AND valid_to IS NULL").bind(a.user,h.active_epoch).first('n')).toBe(10000);
});

it('resumes an owned device with the same history and ID, rotates its upload identity, and replays approval without another rotation',async()=>{
  const a=await actor(),original=await batch(a);await upload(a,original);const old=await currentDevice(env.DB,a.user,a.device),head=await domain(env.DB,a.user),bound=await env.DB.prepare('SELECT bound_at FROM devices WHERE id=?').bind(a.device).first('bound_at'),p=await authorization(a),inspect=await (await call(a,'/api/v3/device-authorizations/inspect','POST',{code:p.userCode})).json<any>();
  expect(inspect.resumableDevices).toEqual([expect.objectContaining({id:a.device,revoked:false,paused:false})]);expect((await approve(a,p,a.device)).status).toBe(200);expect(await (await poll(a,p)).json()).toMatchObject({status:'approved',deviceId:a.device});
  const recovered={...a,credential:p.credential};expect((await currentDevice(env.DB,a.user,a.device)).auth_version).toBe(old.auth_version+1);expect(await env.DB.prepare('SELECT bound_at FROM devices WHERE id=?').bind(a.device).first('bound_at')).toBe(bound);expect(await env.DB.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=?').bind(a.user).first('n')).toBe(1);expect((await events(a)).map(e=>e.total_tokens)).toEqual(['100']);
  expect((await upload(a,original)).status).toBe(401);expect((await upload(recovered,original)).status).toBe(200);await expect(env.DB.batch([guard(env.DB,head,'old-identity',old),endGuard(env.DB,a.user,'old-identity')])).rejects.toThrow(/CHECK/);
  expect((await approve(a,p,a.device)).status).toBe(200);expect((await currentDevice(env.DB,a.user,a.device)).auth_version).toBe(old.auth_version+1);expect((await approve(a,p,null)).status).toBe(409);
  expect((await upload(recovered,await batch(recovered,{seq:2,from:100,response:'new-after-resume',tokens:'20'}))).status).toBe(200);expect((await events(a)).reduce((n,e)=>n+BigInt(e.total_tokens),0n)).toBe(120n);
});

it('rejects resuming another owner or a deleted device, keeps revoked history resumable, and does not let an old authorization cancel the replacement',async()=>{
  const a=await actor(),other=await actor();await upload(a,await batch(a));const foreign=await authorization(other);expect((await approve(other,foreign,a.device)).status).toBe(404);expect((await currentDevice(env.DB,a.user,a.device)).id).toBe(a.device);
  await env.DB.prepare('UPDATE devices SET revoked_at=?,paused=1 WHERE id=?').bind(Date.now(),a.device).run();const first=await authorization(a);expect((await approve(a,first,a.device)).status).toBe(200);expect(await env.DB.prepare('SELECT revoked_at,paused FROM devices WHERE id=?').bind(a.device).first()).toEqual({revoked_at:null,paused:1});expect(await events(a)).toHaveLength(1);
  const second=await authorization(a);expect((await approve(a,second,a.device)).status).toBe(200);expect((await poll(a,first)).status).toBe(410);expect((await approve(a,first,a.device)).status).toBe(410);
  expect((await call(a,'/api/v3/device-authorizations','DELETE',{requestId:first.requestId,pollSecret:first.pollSecret})).status).toBe(200);expect((await poll(a,second)).status).toBe(200);expect(await env.DB.prepare('SELECT token_hash FROM devices WHERE id=? AND revoked_at IS NULL').bind(a.device).first('token_hash')).toBe(await sha256(second.credential));
  await env.DB.prepare('UPDATE devices SET revoked_at=?,history_deleted_at=? WHERE id=?').bind(Date.now(),Date.now(),a.device).run();const deleted=await authorization(a),inspect=await (await call(a,'/api/v3/device-authorizations/inspect','POST',{code:deleted.userCode})).json<any>();expect(inspect.resumableDevices).toEqual([]);expect((await approve(a,deleted,a.device)).status).toBe(409);expect(await (await poll(a,deleted)).json()).toEqual({status:'pending'});expect((await approve(a,deleted,null)).status).toBe(200);expect((await (await poll(a,deleted)).json<any>()).deviceId).not.toBe(a.device);expect(await env.DB.prepare('SELECT history_deleted_at FROM devices WHERE id=?').bind(a.device).first('history_deleted_at')).not.toBeNull();
});

it('publishes a large source replacement in a new epoch only after bounded rebuild steps, preserving old leases',async()=>{
  const a=await actor();expect((await apply(a,await many(a,0,300,1,false)))?.status).toBe('applied');expect((await apply(a,await many(a,300,300,2,true)))?.status).toBe('applied');expect(await events(a)).toHaveLength(600);
  const old=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>(),replacement=await batch(a,{seq:3,generation:2,tokens:'7',response:'new'});
  expect((await upload(a,replacement)).status).toBe(202);expect((await domain(env.DB,a.user)).mode).toBe('rebuilding');expect(await events(a)).toHaveLength(600);
  expect((await call(a,'/api/v3/sync/read','POST',{scope:'full'})).status).toBe(409);const oldSummary=await (await call(a,'/api/v3/usage/local/summary?lease_id='+old.lease_id)).json<any>();expect(oldSummary.data.totalTokens).toBe('600');
  await drain(a);expect((await receipt(env.DB,a.user,replacement.batch_id))?.status).toBe('applied');expect((await events(a)).map(e=>e.total_tokens)).toEqual(['7']);expect((await domain(env.DB,a.user)).active_epoch).not.toBe(old.cut.dataset_epoch);
  expect((await (await call(a,'/api/v3/usage/local/summary?lease_id='+old.lease_id)).json<any>()).data.totalTokens).toBe('600');expect((await call(a,`/api/v3/sync/changes?dataset_epoch=${old.cut.dataset_epoch}&after=${old.cut.commit_seq}`)).status).toBe(409);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_rebuild_candidates WHERE user_id=?').bind(a.user).first('n')).toBe(0);
},30000);

it('reports applied device coverage separately from initial inventory and freezes settings defaults at the read cut',async()=>{
  const a=await actor();await upload(a,await batch(a));const device=async()=> (await (await call(a,'/api/v3/devices')).json<any>()).devices[0],first=await device();expect(first).toMatchObject({id:a.device,protocol:3,paused:false,revoked:false,historyDeleted:false,syncedThreads:1,totalThreads:null,initialComplete:false,sourceCounts:{known:1,complete:1,unavailable:0,pendingBatches:0}});expect(first.receivedAt).toMatch(/Z$/);expect(first.appliedAt).toMatch(/Z$/);expect(first.boundAt).toMatch(/Z$/);
  const status=await worker.fetch(new MatchingRequest(origin+'/api/v3/sync/status',{method:'PUT',headers:{Authorization:'Bearer '+a.credential,'Content-Type':'application/json'},body:JSON.stringify({collectedAt:new Date().toISOString(),totalThreads:1,initialComplete:true,error:null})}),env);expect(status.status).toBe(200);expect((await device()).initialComplete).toBe(true);
  const read=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();expect((await call(a,'/api/v3/settings','PATCH',{timezone:'UTC'})).status).toBe(200);const frozen=await (await call(a,'/api/v3/settings?lease_id='+read.lease_id)).json<any>(),current=await (await call(a,'/api/v3/settings')).json<any>();expect(frozen.data.timezone).toBe('America/New_York');expect(frozen.meta.cut).toEqual(read.cut);expect(current.data.timezone).toBe('UTC');expect(current.config_version).toBe(1);
  const unavailable={...await batch(a,{seq:2}),sources:[],records:[],metadata:[{type:'source_availability' as const,source_id:'source',available:false}],records_hash:await sha256(stableJson([]))};expect((await upload(a,unavailable)).status).toBe(200);expect(await device()).toMatchObject({initialComplete:false,sourceCounts:{known:1,complete:0,unavailable:1}});
});

it('discards a paused rebuild without publishing pending facts, resumes it, and keeps rejected revocation writes out',async()=>{
  const a=await actor();await apply(a,await many(a,0,300,1,false));await apply(a,await many(a,300,300,2,true));const next=await batch(a,{seq:3,generation:2,tokens:'8',response:'replacement'});await upload(a,next);await env.DB.prepare('UPDATE devices SET paused=1 WHERE id=?').bind(a.device).run();await advanceJobs(env.DB,{user:a.user,maxSteps:1});expect((await domain(env.DB,a.user)).mode).toBe('ready');expect((await receipt(env.DB,a.user,next.batch_id))?.status).toBe('received');expect(await events(a)).toHaveLength(600);
  await env.DB.prepare('UPDATE devices SET paused=0 WHERE id=?').bind(a.device).run();await drain(a);expect((await events(a)).map(e=>e.total_tokens)).toEqual(['8']);
},30000);

it('restarts a surviving device rebuild after another uploader deletes history, retaining the received wire and applying it once',async()=>{
  const a=await actor(),b=await actor(a.user);await apply(a,await batch(a));await apply(b,await many(b,0,300,1,false));await apply(b,await many(b,300,300,2,true));
  const replacement=await batch(b,{seq:3,generation:2,response:'replacement-after-other-delete',tokens:'7'});expect((await upload(b,replacement)).status).toBe(202);const job='apply:'+replacement.batch_id;
  await advanceJobs(env.DB,{user:b.user,job_id:job,maxSteps:1});const before=await domain(env.DB,b.user),wireBefore=await env.DB.prepare('SELECT hex(wire) wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(b.user,replacement.batch_id).first<string>('wire');expect(wireBefore).toBeTruthy();
  await env.DB.prepare('UPDATE devices SET revoked_at=?,history_deleted_at=? WHERE user_id=? AND id=?').bind(Date.now(),Date.now(),a.user,a.device).run();expect((await domain(env.DB,b.user)).mode).toBe('deleting');
  await advanceJobs(env.DB,{user:b.user,job_id:job,maxSteps:1});expect(await env.DB.prepare('SELECT kind,state,checkpoint FROM v3_jobs WHERE user_id=? AND job_id=?').bind(b.user,job).first()).toEqual({kind:'apply',state:'pending',checkpoint:'{}'});
  expect((await receipt(env.DB,b.user,replacement.batch_id))?.status).toBe('received');expect(await env.DB.prepare('SELECT hex(wire) wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(b.user,replacement.batch_id).first('wire')).toBe(wireBefore);expect((await domain(env.DB,b.user)).active_epoch).toBe(before.active_epoch);expect((await domain(env.DB,b.user)).mode).toBe('deleting');
  const deletion=await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');expect(deletion.status).toBe(200);expect((await domain(env.DB,b.user)).mode).toBe('ready');expect(await events(b)).toHaveLength(600);
  await drain(b);expect((await receipt(env.DB,b.user,replacement.batch_id))?.status).toBe('applied');expect((await events(b)).map(e=>e.total_tokens)).toEqual(['7']);expect(await env.DB.prepare('SELECT applied_seq FROM v3_producer_progress WHERE user_id=? AND collector_id=?').bind(b.user,b.collector).first('applied_seq')).toBe(3);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_pending_inputs WHERE user_id=?').bind(b.user).first('n')).toBe(0);expect((await domain(env.DB,b.user)).rebuild_job).toBeNull();
},30000);

it('accepts independent account observations through v3 and retains successful quota freshness after a failed attempt',async()=>{
  const a=await actor(),snapshot={schemaVersion:3,quota:{schemaVersion:3,deviceId:a.device,sequence:1,accountRef:'a'.repeat(64),collectedAt:'2026-09-11T00:00:00.000Z',attemptedAt:'2026-09-11T00:00:00.000Z',provider:'app-server',refreshInterval:300,status:'ok',errorCode:null,buckets:[{id:'codex',name:'Codex',primary:{usedPercent:30,remainingPercent:70,windowDurationMins:300,resetsAt:null},secondary:null}]},history:null,historyCollectedAt:null};
  const put=(body:unknown)=>worker.fetch(new MatchingRequest(origin+'/api/v3/accounts/observations',{method:'PUT',headers:{Authorization:'Bearer '+a.credential,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);expect((await put(snapshot)).status).toBe(200);await env.DB.prepare('UPDATE devices SET next_upload_at=0 WHERE id=?').bind(a.device).run();const failed={...snapshot,quota:{...snapshot.quota,sequence:2,status:'error',errorCode:'ACCOUNT_FAILED',attemptedAt:'2026-09-11T01:00:00.000Z',collectedAt:null,buckets:[]}};expect((await put(failed)).status).toBe(200);const views=(await (await call(a,'/api/v3/accounts?deviceIds=missing')).json<any>()).accounts;expect(views).toHaveLength(1);expect(views[0]).toMatchObject({stale:true,quota:{status:'error',collectedAt:'2026-09-11T00:00:00.000Z',attemptedAt:'2026-09-11T01:00:00.000Z'}});expect(views[0].quota.buckets).toHaveLength(1);expect((await put({...failed,quota:{...failed.quota,sequence:1}})).status).toBe(409);
});

it('distinguishes a queued history deletion from completed deletion',async()=>{
  const a=await actor();await upload(a,await batch(a));await env.DB.prepare('UPDATE devices SET revoked_at=?,history_deleted_at=? WHERE id=?').bind(Date.now(),Date.now(),a.device).run();
  const device=async()=> (await (await call(a,'/api/v3/devices')).json<any>()).devices[0];expect(await device()).toMatchObject({revoked:true,historyDeleted:false,historyDeleting:true,deletionStatus:'deleting'});await drain(a);expect(await device()).toMatchObject({historyDeleted:true,historyDeleting:false,deletionStatus:'deleted'});
});

it('replays settings operation IDs, rejects conflicting/base-stale operations, and does not advance config for a no-op',async()=>{
  const a=await actor(),operation={operation_id:'settings-operation',base_config_version:0,timezone:'UTC'},first=await (await call(a,'/api/v3/settings','PATCH',operation)).json<any>();expect(first.config_version).toBe(1);
  const h=await domain(env.DB,a.user);expect(await (await call(a,'/api/v3/settings','PATCH',operation)).json()).toEqual(first);expect((await domain(env.DB,a.user)).commit_seq).toBe(h.commit_seq);
  expect((await call(a,'/api/v3/settings','PATCH',{timezone:'UTC'})).status).toBe(200);expect((await domain(env.DB,a.user)).config_version).toBe(1);
  expect((await call(a,'/api/v3/settings','PATCH',{...operation,timezone:'Asia/Tokyo'})).status).toBe(409);expect((await call(a,'/api/v3/settings','PATCH',{operation_id:'stale',base_config_version:0,timezone:'Asia/Tokyo'})).status).toBe(409);
  expect((await call(a,'/api/v3/settings','PATCH',{operation_id:'new',base_config_version:1,timezone:'Asia/Tokyo'})).status).toBe(200);expect(await (await call(a,'/api/v3/settings','PATCH',operation)).json()).toEqual(first);expect((await (await call(a,'/api/v3/settings')).json<any>()).data.timezone).toBe('Asia/Tokyo');expect((await domain(env.DB,a.user)).config_version).toBe(2);
});

it('atomically applies gzip, replays exact bytes without a second contribution and reclaims temporary input',async()=>{
  const a=await actor(),b=await batch(a);expect((await apply(a,b))?.status).toBe('applied');
  const before=await domain(env.DB,a.user),r=await upload(a,b);expect([r.status,await r.json()]).toEqual([200,expect.objectContaining({status:'applied',contiguous_received_seq:1,contiguous_applied_seq:1})]);
  expect((await events(a)).map(r=>r.total_tokens)).toEqual(['100']);expect((await domain(env.DB,a.user)).commit_seq).toBe(before.commit_seq);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_pending_inputs').first('n')).toBe(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_apply_guards').first('n')).toBe(0);
});
it('rejects extra private fields, changed batch bytes, forged observation identity and cross-device origin',async()=>{
  const a=await actor(),b=await batch(a);const privateBatch=structuredClone(b);privateBatch.records[0].record!.payload.message='never-upload';privateBatch.records_hash=await sha256(stableJson(privateBatch.records));expect((await upload(a,privateBatch)).status).toBe(400);
  expect((await upload(a,b)).status).toBe(200);const changed={...b,metadata:[{type:'source_availability' as const,source_id:'source',available:false}]};expect((await upload(a,changed)).status).toBe(409);
  const forged=await batch(a,{seq:2,from:100,response:'new'});forged.records[0].observation_id='forged';forged.records_hash=await sha256(stableJson(forged.records));expect((await upload(a,forged)).status).toBe(400);
  const other=await actor(a.user),spoof=await batch(other,{originDevice:a.device});expect((await upload(other,spoof)).status).toBe(409);expect(await events(a)).toHaveLength(1);
});
it('rolls back every statement for stale/missing heads, auth races, middle failures and competing writers',async()=>{
  const a=await actor(),h=await domain(env.DB,a.user),device=await currentDevice(env.DB,a.user,a.device);
  const write=(op:string,head=h,fault=false)=>env.DB.batch([guard(env.DB,head,op,device),env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=commit_seq+1,write_version=write_version+1 WHERE user_id=?').bind(a.user),...fault?[env.DB.prepare('INSERT INTO v3_apply_guards VALUES(?,?,0)').bind(a.user,'fault')]:[],endGuard(env.DB,a.user,op)]);
  await expect(write('faulted',h,true)).rejects.toThrow(/CHECK/);expect((await domain(env.DB,a.user)).commit_seq).toBe(0);
  const results=await Promise.allSettled([write('writer-a'),write('writer-b')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await domain(env.DB,a.user)).commit_seq).toBe(1);
  await expect(write('missing',{...h,user_id:'missing'})).rejects.toThrow();
  const fresh=await domain(env.DB,a.user);await env.DB.prepare('UPDATE devices SET paused=1 WHERE id=?').bind(a.device).run();await expect(write('paused',fresh)).rejects.toThrow(/CHECK/);expect((await domain(env.DB,a.user)).commit_seq).toBe(1);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_apply_guards').first('n')).toBe(0);
});
it('deduplicates globally then filters execution origin; copied evidence survives deleting its first uploader',async()=>{
  const a=await actor(),b=await actor(a.user),first=await batch(a);expect((await upload(a,first)).status).toBe(200);
  const copy=await batch(b,{originDevice:a.device,originKind:'preserved',timestamp:first.records[0].record!.timestamp!});expect((await upload(b,copy)).status).toBe(200);
  expect((await upload(b,await batch(b,{seq:2,from:100,response:'response-b',tokens:'20'}))).status).toBe(200);
  const values=await events(a);expect(values).toHaveLength(2);expect(values.filter(r=>r.origin_device_id===a.device).reduce((n,r)=>n+BigInt(r.total_tokens),0n)).toBe(100n);expect(values.filter(r=>r.origin_device_id===b.device).reduce((n,r)=>n+BigInt(r.total_tokens),0n)).toBe(20n);
  const deletion=await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');expect(deletion.status).toBe(200);expect(await events(a)).toHaveLength(2);expect((await upload(a,first)).status).toBe(401);
});
it('keeps a replaced source generation invisible until complete and withdraws obsolete events once',async()=>{
  const a=await actor();await apply(a,await batch(a));const start=await batch(a,{seq:2,generation:2,complete:false,tokens:'40',response:'replacement'});expect((await apply(a,start))?.status).toBe('applied');expect((await events(a)).map(e=>e.total_tokens)).toEqual(['100']);
  const finish=await batch(a,{seq:3,generation:2,from:100,tokens:'2',response:'tail'});expect((await apply(a,finish))?.status).toBe('applied');expect((await events(a)).map(e=>e.total_tokens).sort()).toEqual(['2','40']);
});
it('separates received/applied watermarks across gaps and resumes a persisted request without the original HTTP call',async()=>{
  const a=await actor(),second=await batch(a,{seq:2,from:100,response:'second'}),r=await upload(a,second),ack=await r.json<any>();expect(r.status).toBe(202);expect(ack.contiguous_received_seq).toBe(0);expect(ack.contiguous_applied_seq).toBe(0);
  const first=await batch(a);expect((await upload(a,first)).status).toBe(200);await env.DB.prepare('UPDATE v3_jobs SET next_attempt_at=0').run();await advanceJobs(env.DB,{user:a.user,maxSteps:2});expect((await receipt(env.DB,a.user,second.batch_id))?.status).toBe('applied');
  const receipts=await worker.fetch(new MatchingRequest(origin+'/api/v3/receipts?ids='+second.batch_id,{headers:{Authorization:'Bearer '+a.credential}}),env),data=await receipts.json<any>();expect(data.receipts[0]).toMatchObject({contiguous_received_seq:2,contiguous_applied_seq:2});expect(await events(a)).toHaveLength(2);
});
it('pins paginated entity bodies and relations to a cut, then invalidates old reads after deletion',async()=>{
  const a=await actor();await apply(a,await batch(a));const read=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();expect(read.expected_entities.find((v:any)=>v.kind==='event').count).toBe(1);
  const page=await (await call(a,`/api/v3/sync/read/${read.lease_id}/manifest?limit=1`)).json<any>();await apply(a,await batch(a,{seq:2,generation:2,tokens:'999'}));
  const value=await (await call(a,`/api/v3/sync/read/${read.lease_id}/entities`,'POST',{entities:page.entities})).json<any>();expect(value.entities[0].value.total_tokens).toBe('100');expect(value.cut.commit_seq).toBe(read.cut.commit_seq);
  const other=await actor();expect((await call(other,`/api/v3/sync/read/${read.lease_id}/manifest`)).status).toBe(409);
  await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');expect((await call(a,`/api/v3/sync/read/${read.lease_id}/manifest`)).status).toBe(426);
});
it('accepts a preserved-origin claim before execution evidence and resolves it without trusting the uploader',async()=>{
  const a=await actor(),b=await actor(a.user),first=await batch(a),copy=await batch(b,{originDevice:a.device,originKind:'preserved',timestamp:first.records[0].record!.timestamp!});
  expect((await upload(b,copy)).status).toBe(200);expect((await events(b))[0].origin_device_id).toBeNull();
  expect((await upload(a,first)).status).toBe(200);expect((await events(a))[0].origin_device_id).toBe(a.device);
  await call(a,'/api/v3/devices/'+a.device+'/history','DELETE');expect((await events(b))[0].origin_device_id).toBe(a.device);
});
it('clones recent into full at the same cut, freezes changes to a target lease, and streams oversized integers exactly through page DTOs',async()=>{
  const a=await actor(),huge='9223372036854775808123';await apply(a,await batch(a,{tokens:huge}));
  const recent=await (await call(a,'/api/v3/sync/read','POST',{scope:'recent'})).json<any>();await apply(a,await batch(a,{seq:2,from:100,response:'second',tokens:'17'}));
  const full=await (await call(a,'/api/v3/sync/read','POST',{scope:'full',from_lease_id:recent.lease_id})).json<any>();expect(full.cut).toEqual(recent.cut);expect(full.total_entities).toBe(recent.total_entities);
  const summary=await (await call(a,'/api/v3/usage/local/summary?lease_id='+full.lease_id)).json<any>();expect(summary.data.totalTokens).toBe(huge);expect(summary.meta.cut).toEqual(full.cut);
  const target=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();await apply(a,await batch(a,{seq:3,from:200,response:'third',tokens:'9'}));
  const change=await (await call(a,`/api/v3/sync/changes?dataset_epoch=${target.cut.dataset_epoch}&after=${recent.cut.commit_seq}&lease_id=${target.lease_id}`)).json<any>();expect(change.next_cursor).toBe(target.cut.commit_seq);expect(change.more).toBe(false);expect(change.commits).toHaveLength(1);expect(change.commits[0].complete).toBe(true);
  const scalar=await env.DB.prepare('SELECT payload FROM v3_aggregates WHERE user_id=? AND aggregate_key=?').bind(a.user,'["all"]').first<string>('payload');expect(JSON.parse(scalar!)).toMatchObject({events:3,thread_count:1,turn_count:1});expect(JSON.parse(scalar!)).not.toHaveProperty('threads');
});
it('resolves deferred legacy fork inheritance when the complete parent arrives and reclaims temporary projections',async()=>{
  const a=await actor();let seq=0;
  const emit=async(thread:string,source:string,from:number,record:any,parent:string|null,complete:boolean)=>{
    const b=await batch(a,{seq:++seq,source,from,record,complete});const context={...b.records[0].context,thread_id:thread,forked_from_id:parent};b.records[0].context=context;b.sources[0].context=context;b.sources[0].context_hash=await sha256(stableJson(context));b.records_hash=await sha256(stableJson(b.records));const r=await apply(a,b);expect(r?.status).toBe('applied');
  };
  const meta=(id:string,parent?:string)=>({type:'session_meta',timestamp:'2026-09-11T12:00:00.000Z',payload:{id,timestamp:'2026-09-11T12:00:00.000Z',...(parent?{forked_from_id:parent}:{})}});
  const cumulative=(total:string,last:string,at='2026-09-11T10:00:00.000Z')=>({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:normalizeTokens({input_tokens:total,output_tokens:'0',total_tokens:total}),last_token_usage:normalizeTokens({input_tokens:last,output_tokens:'0',total_tokens:last})}}});
  await emit('child','child-source',0,meta('child','parent'),'parent',false);await emit('child','child-source',100,cumulative('100','100'),'parent',false);await emit('child','child-source',200,cumulative('120','20','2026-09-11T13:00:00.000Z'),'parent',true);
  expect(await events(a)).toHaveLength(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_deferred_records').first('n')).toBe(2);
  await emit('parent','parent-source',0,meta('parent'),null,false);await emit('parent','parent-source',100,cumulative('100','100'),null,true);
  await advanceJobs(env.DB,{user:a.user,maxSteps:4});expect((await events(a)).reduce((n,r)=>n+BigInt(r.total_tokens),0n)).toBe(120n);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_deferred_records').first('n')).toBe(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_dependencies').first('n')).toBe(0);
});
