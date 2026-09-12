import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import worker from '../src/index';
import {SESSION_COOKIE,sha256,token} from '../src/http';
import {domain,receipt} from '../src/v3/store';
import {advanceJobs} from '../src/v3/jobs';
import {V3_CONTENT_TYPE,stableJson,type LegacyPreparation,type UploadBatch} from '../../shared/sync-v3';
import {normalizeTokens} from '../../shared/usage-domain/normalize';
import fixture from './fixtures/legacy-production.json';
import crossLane from '../.generated/legacy-cross-lane.json';

// These immutable wires were produced by the actual Importer + UsageSync and Collector + encodeUpload
// against the same raw file (SHA-256 in fixture.source). No event identity is invented to join the formats.
const origin='https://quota.esoren.com';
type Actor={user:string;session:string;device:string;credential:string};
async function actor(device=fixture.device,user?:string):Promise<Actor>{const id=user||crypto.randomUUID(),session=token(),credential=token();
  if(!user)await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'migration-regression',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),id,Date.now()+86400000).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol) VALUES(?,?,?,?,?,2)').bind(device,id,device,await sha256(credential),Date.now()).run();return {user:id,session,device,credential};}
const call=(a:Actor,path:string,method='GET',body?:unknown)=>worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+a.session,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)}),env);
const machine=(a:Actor,path:string,method:string,body:unknown)=>worker.fetch(new Request(origin+path,{method,headers:{Authorization:'Bearer '+a.credential,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
const batch=()=>structuredClone(fixture.batches.find(b=>b.phase==='weak-v3-C')!.batch) as UploadBatch;
const handoff=()=>structuredClone(fixture.batches.find(b=>b.phase==='weak-handoff-C')!.batch) as UploadBatch;
const preparation=():LegacyPreparation=>({collector_id:batch().collector_id,replacements:handoff().metadata as LegacyPreparation['replacements']});
async function upload(a:Actor,b:UploadBatch){for(const s of b.sources)s.context_hash=await sha256(stableJson(s.context));for(const r of b.records)r.observation_id=await sha256(stableJson([b.collector_id,r.source_id,r.generation,r.locator]));b.records_hash=await sha256(stableJson(b.records));return worker.fetch(new Request(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:gzipSync(stableJson(b))}),env);}
async function originalUpload(a:Actor){return worker.fetch(new Request(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:Uint8Array.from(atob(fixture.batches.find(b=>b.phase==='weak-v3-C')!.wireBase64),c=>c.charCodeAt(0))}),env);}
async function total(a:Actor,lease?:string){const r=await call(a,'/api/v3/usage/local/summary'+(lease?'?lease_id='+lease:''));expect(r.status).toBe(200);return (await r.json<any>()).data.totalTokens;}
async function activeTotal(a:Actor){const rows=(await env.DB.prepare('SELECT payload FROM v3_events WHERE user_id=? AND epoch=(SELECT active_epoch FROM v3_sync_domains WHERE user_id=?)').bind(a.user,a.user).all<{payload:string}>()).results;return rows.reduce((n,r)=>n+BigInt(JSON.parse(r.payload).total_tokens),0n).toString();}
async function drain(a:Actor,check?:()=>Promise<void>){for(let i=0;i<100;i++){await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(a.user).run();const r=await advanceJobs(env.DB,{user:a.user,maxSteps:1,budgetMs:10000});await check?.();if(!r.steps)return;}throw Error('Migration jobs did not complete');}
async function legacy(a:Actor){for(const e of fixture.v2Uploads.filter(r=>['sync/chunks','sync/commit'].includes(r.route)))expect((await machine(a,'/api/v2/'+e.route,e.method,e.body)).status).toBe(200);await domain(env.DB,a.user);await drain(a);expect(await total(a)).toBe('100');}
async function prepare(a:Actor,p=preparation()){return machine(a,'/api/v3/legacy/prepare','POST',p);}

it('keeps every readable cut at 100 across incomplete real records, replay, disconnected handoff, and atomic publication',async()=>{
  const a=await actor();await legacy(a);const old=await (await call(a,'/api/v3/sync/read','POST',{scope:'full'})).json<any>();
  expect((await prepare(a)).status).toBe(200);expect((await prepare(a)).status).toBe(200);
  const partial=batch();partial.sources[0].generation_complete=false;partial.sources[0].replace_end=false;
  expect((await upload(a,partial)).status).toBe(200);expect(await total(a)).toBe('100');expect((await domain(env.DB,a.user)).mode).toBe('ready');
  expect((await upload(a,partial)).status).toBe(200);expect(await total(a)).toBe('100');
  const complete=structuredClone(partial);complete.batch_id=crypto.randomUUID();complete.lane_seq++;complete.records=[];complete.sources[0]={...complete.sources[0],from_cursor:complete.sources[0].to_cursor,replace_start:false,replace_end:true,generation_complete:true};
  expect((await upload(a,complete)).status).toBe(200);await drain(a);expect(await total(a)).toBe('100');
  const finish=handoff();finish.lane_seq=complete.lane_seq+1;expect((await upload(a,finish)).status).toBe(202);
  let checked=0;await drain(a,async()=>{expect(await activeTotal(a)).toBe('100');expect(await total(a,old.lease_id)).toBe('100');const r=await call(a,'/api/v3/usage/local/summary');expect([200,409]).toContain(r.status);if(r.status===200){expect((await r.json<any>()).data.totalTokens).toBe('100');checked++;}});
  expect(checked).toBeGreaterThan(0);expect((await receipt(env.DB,a.user,finish.batch_id))?.status).toBe('applied');expect(await total(a)).toBe('100');expect((await domain(env.DB,a.user)).active_epoch).not.toBe(old.cut.dataset_epoch);
  expect((await upload(a,finish)).status).toBe(200);expect((await prepare(a)).status).toBe(200);expect(await total(a)).toBe('100');
  const next=structuredClone(batch());next.batch_id=crypto.randomUUID();next.lane_seq=finish.lane_seq+1;const start=complete.sources[0].to_cursor;
  next.records=[{...next.records.at(-1)!,observation_id:'new-after-migration',locator:start,byte_end:start+100,prefix_hash:await sha256('new-after-migration'),record:{type:'token_usage_record',timestamp:'2026-09-12T12:00:00Z',payload:{response_id:'new-after-migration',usage:normalizeTokens({total_tokens:'7'})}}}];next.sources[0]={...next.sources[0],from_cursor:start,to_cursor:start+100,snapshot_eof:start+100,replace_start:false};
  expect((await upload(a,next)).status).toBe(200);expect(await total(a)).toBe('107');
});

it('preserves the complete old history when a mapped source is missing or not complete',async()=>{
  const a=await actor();await legacy(a);expect((await prepare(a)).status).toBe(200);const partial=batch();partial.sources[0].generation_complete=false;partial.sources[0].replace_end=false;expect((await upload(a,partial)).status).toBe(200);
  const finish=handoff();(finish.metadata[0] as LegacyPreparation['replacements'][0]).sources.push({source_id:'missing-original',generation:1});expect((await upload(a,finish)).status).toBe(409);
  await drain(a);expect(await total(a)).toBe('100');expect(await env.DB.prepare('SELECT retired_revision FROM v3_legacy_heads WHERE user_id=?').bind(a.user).first('retired_revision')).toBe(0);
});

it('registers concurrent identical preparations idempotently without leaking guards or changing the old total',async()=>{
  const a=await actor();await legacy(a);const responses=await Promise.all([prepare(a),prepare(a)]);expect(responses.map(r=>r.status)).toEqual([200,200]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_legacy_pending_sources WHERE user_id=?').bind(a.user).first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_apply_guards WHERE user_id=?').bind(a.user).first('n')).toBe(0);expect(await total(a)).toBe('100');
});

it('repairs an already applied old-client partial source, then safely replays its unchanged wire and completes handoff',async()=>{
  const a=await actor();await legacy(a);expect((await originalUpload(a)).status).toBe(200);expect(await total(a)).toBe('200');
  expect((await prepare(a)).status).toBe(202);await drain(a);expect(await total(a)).toBe('100');expect((await prepare(a)).status).toBe(200);
  expect((await originalUpload(a)).status).toBe(200);expect(await total(a)).toBe('100');expect((await upload(a,handoff())).status).toBe(202);await drain(a,async()=>{expect(await activeTotal(a)).toBe('100');});expect(await total(a)).toBe('100');
});

it('does not stage another collector, an unrelated source, or old history that the authenticated device does not own',async()=>{
  const a=await actor();await legacy(a);expect((await prepare(a)).status).toBe(200);
  const other=await actor('other-device',a.user);expect((await prepare(other)).status).toBe(409);
  const copied=batch();copied.collector_id='other-collector';copied.batch_id=crypto.randomUUID();for(const r of copied.records)r.observation_id='copy:'+r.observation_id;
  const unmapped={...preparation(),collector_id:copied.collector_id};expect((await prepare(other,unmapped)).status).toBe(200);expect((await upload(other,copied)).status).toBe(200);
  expect(await total(a)).toBe('200'); // Weak identities across independent collectors are intentionally not guessed equal.
  expect((await originalUpload(a)).status).toBe(200);expect(await total(a)).toBe('200');
});

it('rejects an oversized preparation without changing data and keeps a revoked repair from publishing',async()=>{
  const a=await actor();await legacy(a);const invalid=preparation();invalid.replacements[0].sources=Array.from({length:501},(_,i)=>({source_id:'source-'+i,generation:1}));expect((await prepare(a,invalid)).status).toBe(400);expect(await total(a)).toBe('100');
  expect((await originalUpload(a)).status).toBe(200);expect((await prepare(a)).status).toBe(202);const epoch=(await domain(env.DB,a.user)).active_epoch;
  await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=?').bind(Date.now(),a.device).run();await drain(a);expect((await domain(env.DB,a.user)).active_epoch).toBe(epoch);expect((await domain(env.DB,a.user)).mode).toBe('ready');expect((await prepare(a)).status).toBe(401);
});

it('keeps a pending migration source private when the same batch publishes an unrelated large source replacement',async()=>{
  const a=await actor();await legacy(a);expect((await prepare(a)).status).toBe(200);
  const large=(seq:number,start:number,count:number,generation=1):UploadBatch=>{
    const b=batch(),context={...b.sources[0].context,thread_id:'unrelated'},template=b.records.at(-1)!;b.batch_id=crypto.randomUUID();b.lane_seq=seq;b.metadata=[];
    b.sources=[{...b.sources[0],source_id:'large-source',generation,context,from_cursor:start*100,to_cursor:(start+count)*100,snapshot_eof:50100,replace_start:start===0,replace_end:start+count===501,generation_complete:start+count===501}];
    b.records=Array.from({length:count},(_,index)=>{const n=start+index;return {...template,source_id:'large-source',generation,locator:n*100,byte_end:(n+1)*100,context,record:{type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{thread_id:'unrelated',turn_id:'turn',response_id:'large-'+n,usage:normalizeTokens({total_tokens:'1'})}}};});return b;
  };
  expect((await upload(a,large(1,0,300))).status).toBe(200);expect((await upload(a,large(2,300,201))).status).toBe(200);expect(await total(a)).toBe('601');
  const replacement=large(3,0,1,2);replacement.sources[0]={...replacement.sources[0],snapshot_eof:100,replace_end:true,generation_complete:true};replacement.records[0].record!.payload.response_id='large-replacement';replacement.records[0].record!.payload.usage=normalizeTokens({total_tokens:'7'});
  const pending=batch();replacement.sources.push(...pending.sources);replacement.records.push(...pending.records);
  expect((await upload(a,replacement)).status).toBe(202);await drain(a);expect(await total(a)).toBe('107');
  expect(await env.DB.prepare('SELECT active FROM v3_sources WHERE user_id=? AND source_id=?').bind(a.user,pending.sources[0].source_id).first('active')).toBe(0);
  const finish=handoff();finish.lane_seq=4;expect((await upload(a,finish)).status).toBe(202);await drain(a,async()=>{expect(await activeTotal(a)).toBe('107');});expect(await total(a)).toBe('107');
});

it('acknowledges an immutable old backfill handoff as superseded after actual live generation 2, then publishes the replacement at 105',async()=>{
  const a=await actor(crossLane.device);for(const e of crossLane.v2Uploads.filter(r=>['sync/chunks','sync/commit'].includes(r.route)))expect((await machine(a,'/api/v2/'+e.route,e.method,e.body)).status).toBe(200);await domain(env.DB,a.user);await drain(a);expect(await total(a)).toBe('100');
  const send=(entry:typeof crossLane.uploads[number])=>worker.fetch(new Request(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:Uint8Array.from(atob(entry.wireBase64),c=>c.charCodeAt(0))}),env);
  for(const p of crossLane.preparations.filter(p=>p.phase==='initial'))expect((await machine(a,'/api/v3/legacy/prepare','POST',p.body)).status).toBe(200);
  const first=crossLane.uploads.find(b=>b.phase==='initial')!;expect((await send(first)).status).toBe(200);expect(await total(a)).toBe('100');
  for(const p of crossLane.preparations.filter(p=>p.phase==='restart-new-generation'))expect((await machine(a,'/api/v3/legacy/prepare','POST',p.body)).status).toBe(200);
  const live=crossLane.uploads.find(b=>b.batch.sources.some(s=>s.generation===2))!,old=crossLane.uploads.find(b=>b.phase==='persist-old-handoff')!,replayed=crossLane.uploads.find(b=>b.phase==='restart-new-generation'&&b.batch.metadata.some(m=>m.type==='legacy_replacement'))!;
  expect(live.batch.lane).toBe('live');expect(old.batch.lane).toBe('backfill');expect(old.wireBase64).toBe(replayed.wireBase64);
  expect((await send(live)).status).toBe(200);expect((await receipt(env.DB,a.user,live.batch.batch_id))?.status).toBe('applied');expect(await total(a)).toBe('100');
  const response=await send(old);expect(response.status).toBe(200);const result=await response.json<any>();expect(result.handoff_results).toEqual([{dataset_id:crossLane.preparations[0].body.replacements[0].dataset_id,thread_id:crossLane.thread,status:'superseded'}]);
  expect(await total(a)).toBe('100');expect(await env.DB.prepare('SELECT retired_revision FROM v3_legacy_heads WHERE user_id=?').bind(a.user).first('retired_revision')).toBe(0);expect((await domain(env.DB,a.user)).mode).toBe('ready');
  expect(await (await send(replayed)).json()).toEqual(result);
  const poll=await worker.fetch(new Request(origin+'/api/v3/receipts?ids='+old.batch.batch_id,{headers:{Authorization:'Bearer '+a.credential}}),env);expect((await poll.json<any>()).receipts[0].handoff_results).toEqual(result.handoff_results);
  const current=crossLane.uploads.find(b=>b.phase==='current-handoff')!;expect(current.batch.lane_seq).toBe(old.batch.lane_seq+1);expect((await send(current)).status).toBe(202);
  await drain(a,async()=>{expect(['100','105']).toContain(await activeTotal(a));});expect(await total(a)).toBe('105');expect((await receipt(env.DB,a.user,current.batch.batch_id))?.status).toBe('applied');
  expect(await env.DB.prepare('SELECT generation FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id=? AND active=1').bind(a.user,live.batch.collector_id,live.batch.sources[0].source_id).first('generation')).toBe(2);
});
