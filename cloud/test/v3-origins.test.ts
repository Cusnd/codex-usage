import {matchingDevice} from './matching-build';
import {MatchingRequest} from './matching-build';
import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import worker from '../src/index';
import {SESSION_COOKIE,sha256,token} from '../src/http';
import {domain,receipt} from '../src/v3/store';
import {prepareMaterialization,type CandidateRow} from '../src/v3/apply';
import {advanceJobs} from '../src/v3/jobs';
import {stableJson,V3_CONTENT_TYPE,type UploadBatch} from '../../shared/sync-v3';
import fixture from '../.generated/collector-origins.json';

const origin='https://quota.esoren.com';
type Actor={user:string;device:string;session:string;credential:string};
async function actor(name:keyof typeof fixture.devices,user?:string):Promise<Actor>{
  const id=user||crypto.randomUUID(),device=fixture.devices[name],session=token(),credential=token();
  if(!user)await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'origin-regression',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),id,Date.now()+86400000).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol) VALUES(?,?,?,?,?,3)').bind(device,id,name,await sha256(credential),Date.now()).run();await matchingDevice(env.DB,device);
  return {user:id,device,session,credential};
}
const call=(a:Actor,path:string,method='GET')=>worker.fetch(new MatchingRequest(origin+path,{method,headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+a.session}}),env);
async function drain(a:Actor){for(let i=0;i<80;i++){await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(a.user).run();if(!(await advanceJobs(env.DB,{user:a.user,maxSteps:1,budgetMs:10000})).steps)return;}throw Error('origin jobs did not finish');}
async function send(a:Actor,phase:string,afterBatch?:(batch:UploadBatch)=>Promise<void>){for(const entry of fixture.batches.filter(b=>b.phase===phase)){
  const r=await worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:Uint8Array.from(atob(entry.wireBase64),c=>c.charCodeAt(0))}),env);
  expect([200,202]).toContain(r.status);await drain(a);expect((await receipt(env.DB,a.user,entry.batch.batch_id))?.status).toBe('applied');
  await afterBatch?.(entry.batch as UploadBatch);
}}
async function summary(a:Actor,device?:string){const r=await call(a,'/api/v3/usage/local/summary'+(device?'?deviceIds='+encodeURIComponent(device):''));expect(r.status).toBe(200);return (await r.json<any>()).data;}
async function event(a:Actor){return JSON.parse((await env.DB.prepare('SELECT payload FROM v3_events WHERE user_id=? AND epoch=(SELECT active_epoch FROM v3_sync_domains WHERE user_id=?) AND event_id=?').bind(a.user,a.user,'response:'+fixture.response).first<string>('payload'))!);}
async function remove(a:Actor){expect([200,202]).toContain((await call(a,'/api/v3/devices/'+a.device+'/history','DELETE')).status);await drain(a);}
async function initial(a:Actor){await send(a,'initial-A');await send(a,'append-A');}

it('keeps real local append proof through disconnect, persistent Store restart and same-device rebind',async()=>{
  const a=await actor('A');await initial(a);expect((await summary(a,a.device)).totalTokens).toBe('20');await send(a,'rebind-A');
  expect((await summary(a)).totalTokens).toBe('20');expect((await summary(a,a.device)).totalTokens).toBe('20');expect((await event(a)).origin_device_id).toBe(a.device);
});
it('recovers the unchanged raw prefix from an older Collector rescan and still withdraws it after correction',async()=>{
  const a=await actor('A'),b=await actor('B',a.user);await initial(a);await send(b,'copy-B');
  const oldClient=structuredClone(fixture.batches.find(b=>b.phase==='rebind-A')!.batch) as UploadBatch;
  for(const r of oldClient.records)r.origin={kind:'observed_local',device_id:a.device};oldClient.records_hash=await sha256(stableJson(oldClient.records));
  const r=await worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:gzipSync(stableJson(oldClient))}),env);expect([200,202]).toContain(r.status);await drain(a);
  expect((await summary(a,a.device)).totalTokens).toBe('20');await send(a,'corrected-A');expect((await event(a)).origin_device_id).toBeNull();
  await remove(a);expect((await event(b)).origin_device_id).toBeNull();
});
it('preserves natural origin in an ordinary byte-identical copy, including copy-first arrival and later copy rescan',async()=>{
  const a=await actor('A'),b=await actor('B',a.user);await send(b,'copy-B');expect((await event(a)).origin_device_id).toBeNull();await initial(a);
  await remove(a);expect((await summary(b)).totalTokens).toBe('20');expect((await summary(b,a.device)).totalTokens).toBe('20');
  await send(b,'rebind-B');expect((await summary(b,a.device)).totalTokens).toBe('20');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_candidates WHERE user_id=? AND uploader_device_id=?').bind(a.user,a.device).first('n')).toBe(0);
  await remove(b);const c=await actor('C',a.user);await send(c,'fresh-copy-C');expect((await summary(c)).totalTokens).toBe('20');expect((await event(c)).origin_device_id).toBeNull();
});
it('withdraws inherited proof when the original raw event is corrected, without changing the surviving copy into a proof',async()=>{
  const a=await actor('A'),b=await actor('B',a.user);await initial(a);await send(b,'copy-B');await send(a,'rebind-A');await send(a,'corrected-A');
  expect(await event(a)).toMatchObject({origin_device_id:null,conflict:true});expect((await summary(a,a.device)).totalTokens).toBe('0');
  await remove(a);expect((await event(b)).origin_device_id).toBeNull();expect((await summary(b)).totalTokens).toBe('20');
});
it('keeps conflicting local append evidence ambiguous after an ordinary copy and deleting either witness',async()=>{
  const a=await actor('A'),b=await actor('B',a.user),d=await actor('D',a.user);await initial(a);await send(b,'copy-B');await send(d,'initial-D');await send(d,'append-D');
  expect(await event(a)).toMatchObject({origin_device_id:null,origin_conflict:true,total_tokens:'20'});await remove(a);expect(await event(b)).toMatchObject({origin_device_id:null,origin_conflict:true});
  await remove(d);expect(await event(b)).toMatchObject({origin_device_id:null,origin_conflict:true});
});
it('clears copied origin when a new source generation explicitly withdraws execution evidence',async()=>{
  const a=await actor('A'),b=await actor('B',a.user);await initial(a);await send(b,'copy-B');
  const revised=structuredClone(fixture.batches.find(b=>b.phase==='rebind-A')!.batch) as UploadBatch;revised.batch_id=crypto.randomUUID();
  for(const record of revised.records)record.origin={kind:'unknown',device_id:null};revised.records_hash=await sha256(stableJson(revised.records));
  const response=await worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+a.credential,'Content-Type':V3_CONTENT_TYPE},body:gzipSync(stableJson(revised))}),env);expect([200,202]).toContain(response.status);await drain(a);
  expect(await event(a)).toMatchObject({origin_device_id:null,total_tokens:'20'});expect((await receipt(env.DB,a.user,revised.batch_id))?.status).toBe('applied');
});
it('retracts inherited witnesses and produces a new event revision for a corrected observation',async()=>{
  const a=await actor('A'),b=await actor('B',a.user);await initial(a);await send(b,'copy-B');
  const old=(await env.DB.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND uploader_device_id=?').bind(a.user,a.device).all<CandidateRow>()).results[0];
  const value=JSON.parse(old.candidate);delete value.origin_proofs;value.origin={kind:'unknown',device_id:null};value.record_revision++;
  const mutations=new Map<string,CandidateRow|null>([[old.observation_id,{...old,record_revision:old.record_revision+1,candidate:stableJson(value)}]]);
  const prepared=await prepareMaterialization(env.DB,await domain(env.DB,a.user),[old],mutations);
  expect(prepared.deltas).toHaveLength(1);expect(prepared.deltas[0].before?.origin_device_id).toBe(a.device);expect(prepared.deltas[0].after?.origin_device_id).toBeNull();
  const revision=await env.DB.prepare('SELECT revision FROM v3_events WHERE user_id=? AND event_id=?').bind(a.user,old.event_id).first<number>('revision');expect(prepared.changes[0].revision).toBe(revision!+1);
  expect([...mutations.values()].filter(r=>r?.uploader_device_id===b.device).map(r=>JSON.parse(r!.candidate).origin_proofs)).toEqual([[]]);
});
it('publishes correction and inherited-origin withdrawal together when a real 502-event source requires a shadow rebuild',async()=>{
  const e=await actor('E'),f=await actor('F',e.user);await send(e,'initial-E');await send(e,'append-E');await send(f,'copy-F');const before=await domain(env.DB,e.user);
  expect((await summary(e,e.device)).totalTokens).toBe('521');
  await send(e,'corrected-E',async batch=>{
    const complete=batch.sources.every(s=>s.generation_complete);expect((await summary(e,e.device)).totalTokens).toBe(complete?'0':'521');
  });
  expect((await domain(env.DB,e.user)).active_epoch).not.toBe(before.active_epoch);expect((await event(e)).origin_device_id).toBeNull();
  const copy=(await env.DB.prepare('SELECT candidate FROM v3_candidates WHERE user_id=? AND uploader_device_id=?').bind(e.user,f.device).all<{candidate:string}>()).results;
  expect(copy).toHaveLength(502);expect(copy.every(r=>JSON.parse(r.candidate).origin_proofs.length===0)).toBe(true);
  await remove(e);expect((await summary(f)).totalTokens).toBe('521');expect((await summary(f,e.device)).totalTokens).toBe('0');
},30000);
