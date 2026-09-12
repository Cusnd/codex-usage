import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/index';
import { SESSION_COOKIE,sha256,token } from '../src/http';
import { SYNC_CHUNK_EVENTS,type SyncEvent,type SyncThread,type SyncManifest } from '../../shared/usage-sync';
import fixture from '../.generated/parity.json';
import { cleanupUsage } from '../src/usage-sync';
import type { CloudAccountSnapshot } from '../../shared/usage-sync';

const origin='https://quota.esoren.com';
async function actor(){const user=crypto.randomUUID(),session=token();await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at,settings) VALUES(?,?,?,?,?)').bind(user,user,'fixture-user',Date.now(),JSON.stringify(fixture.settings)).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();return {user,session};}
async function device(user:string,name:string){const id=crypto.randomUUID(),credential=token();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol) VALUES(?,?,?,?,?,2)').bind(id,user,name,await sha256(credential),Date.now()).run();return {id,credential};}
async function req(path:string,session:string,method='GET',body?:unknown,bearer=false){return worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+session}:{Cookie:SESSION_COOKIE+'='+session})},body:body===undefined?undefined:JSON.stringify(body)}),env);}
async function upload(d:{id:string;credential:string},thread:SyncThread,events:SyncEvent[],revision=1,commit=true){
  const chunks:SyncEvent[][]=[];for(let i=0;i<events.length;i+=SYNC_CHUNK_EVENTS)chunks.push(events.slice(i,i+SYNC_CHUNK_EVENTS));if(!chunks.length)chunks.push([]);
  const hashes=await Promise.all(chunks.map(c=>sha256(JSON.stringify(c))));
  const m:SyncManifest={schemaVersion:2,datasetId:'dataset',thread,revision,parserVersion:1,collectedAt:'2026-11-02T00:00:00.000Z',eventCount:events.length,chunkCount:chunks.length,contentHash:await sha256(JSON.stringify(thread)+'|'+hashes.join('|'))};
  for(let index=0;index<chunks.length;index++){const r=await req('/api/v2/sync/chunks',d.credential,'PUT',{manifest:m,index,events:chunks[index]},true);expect([r.status,await r.json()]).toEqual([200,{ok:true,index}]);}
  if(commit){const r=await req('/api/v2/sync/commit',d.credential,'POST',m,true);expect([r.status,await r.json()]).toEqual([200,{ok:true,acceptedSequence:revision}]);}return m;
}
it('matches native SQLite across device scopes, bigint costs, 200-row pages, DST buckets, Agent relationships and comparisons',async()=>{
  const a=await actor(),ids:Record<string,string>={};
  for(const [name,data] of Object.entries(fixture.devices)){const d=await device(a.user,name);ids[name]=d.id;
    for(const t of data.threads)await upload(d,t as SyncThread,data.events.filter(e=>e.thread_id===t.id) as SyncEvent[]);}
  for(const expected of fixture.expected)for(const c of expected.cases){const search=new URLSearchParams();for(const key of expected.selection)search.append('deviceIds',ids[key]);for(const [key,value] of Object.entries(c.params))search.set(key,String(value));
    const r=await req('/api/v2/usage/'+c.route+'?'+search,a.session);const body=await r.json<any>();expect(r.status,JSON.stringify(body)).toBe(200);expect(body.data,JSON.stringify([expected.selection,c.route,c.params])).toEqual(c.data);}
},30000);
it('keeps the last complete revision during interrupted uploads, handles retries and corrects old usage',async()=>{
 const a=await actor(),d=await device(a.user,'A'),t=fixture.devices.A.threads[0] as SyncThread,e=fixture.devices.A.events.slice(0,1) as SyncEvent[];
 await upload(d,t,e);const get=async()=> (await (await req('/api/v2/usage/local/summary',a.session)).json<any>()).data;
 const previous=await get(),fixed=[{...e[0],total_tokens:'100',input_tokens:'80'}];const m=await upload(d,t,fixed,2,false);
 expect(await get()).toEqual(previous);await upload(d,t,fixed,2);expect((await get()).totalTokens).toBe('100');
 expect((await req('/api/v2/sync/commit',d.credential,'POST',m,true)).status).toBe(200);
 const bad={...m,revision:3};expect((await req('/api/v2/sync/commit',d.credential,'POST',bad,true)).status).toBe(409);
});
it('isolates users, preserves revoked history, blocks late writes and deletes only the selected device history',async()=>{
 const a=await actor(),b=await actor(),d=await device(a.user,'A'),t=fixture.devices.A.threads[0] as SyncThread,e=fixture.devices.A.events.slice(0,1) as SyncEvent[];
 const m=await upload(d,t,e);expect((await req('/api/v2/usage/local/summary?deviceIds='+d.id,b.session)).status).toBe(404);
 expect((await req('/api/v2/devices/'+d.id,b.session,'DELETE')).status).toBe(404);
 expect((await req('/api/v2/devices/'+d.id,a.session,'DELETE')).status).toBe(200);
 expect((await (await req('/api/v2/usage/local/summary',a.session)).json<any>()).data.eventCount).toBe(1);
 expect((await req('/api/v2/sync/commit',d.credential,'POST',m,true)).status).toBe(401);
 expect((await req('/api/v2/devices/'+d.id+'/history',a.session,'DELETE')).status).toBe(200);
 expect((await (await req('/api/v2/usage/local/summary',a.session)).json<any>()).data.eventCount).toBe(0);
});
it('adds multiple bindings without replacement and gives collectors a common account key unavailable to browser sessions',async()=>{
 const a=await actor(),d=await device(a.user,'existing'),secret=token();
 const start=await req('/api/v2/device-authorizations',a.session,'POST',{deviceName:'second',tokenHash:await sha256(secret)});const p=await start.json<any>();expect(start.status).toBe(201);
 expect((await req('/api/v2/device-authorizations/approve',a.session,'POST',{code:p.userCode,replaceDeviceId:null})).status).toBe(200);
 const list=await (await req('/api/v2/devices',a.session)).json<any>();expect(list.devices).toHaveLength(2);
 const one=await (await req('/api/v2/sync/config',d.credential,'GET',undefined,true)).json<any>(),two=await (await req('/api/v2/sync/config',secret,'GET',undefined,true)).json<any>();expect(one.accountKey).toBe(two.accountKey);
 expect((await req('/api/v2/sync/config',a.session)).status).toBe(401);
});
it('deduplicates confirmed accounts, separates unknown devices, preserves failed snapshots and historical days, and stops showing the old account after switching',async()=>{
 const a=await actor(),d=await device(a.user,'A'),b=await device(a.user,'B');
 const snapshot=(id:string,ref:string|null,sequence=1,day='2026-09-10'):CloudAccountSnapshot=>({schemaVersion:2,quota:{schemaVersion:1,deviceId:id,sequence,accountRef:ref,
   collectedAt:ref?'2026-09-11T00:00:00.000Z':null,attemptedAt:'2026-09-11T00:00:00.000Z',provider:ref?'app-server':null,refreshInterval:300,status:ref?'ok':'identity_unknown',errorCode:ref?null:'IDENTITY_UNKNOWN',buckets:ref?[{id:'codex',name:'Codex',primary:{usedPercent:30,remainingPercent:70,windowDurationMins:300,resetsAt:null},secondary:null}]:[]},
   history:ref?{summary:{lifetimeTokens:'9007199254740993',peakDailyTokens:null,longestRunningTurnSec:null,currentStreakDays:null,longestStreakDays:null},dailyUsageBuckets:[{startDate:day,tokens:'9007199254740993'}]}:null,historyCollectedAt:ref?'2026-09-11T00:00:00.000Z':null});
 const put=async(dev:typeof d,p:CloudAccountSnapshot)=>{await env.DB.prepare('UPDATE devices SET next_upload_at=0 WHERE id=?').bind(dev.id).run();const r=await req('/api/v2/sync/accounts',dev.credential,'PUT',p,true);expect(r.status,JSON.stringify(await r.json())).toBe(200);};
 const get=async()=> (await (await req('/api/v2/accounts',a.session)).json<any>()).accounts;
 await put(d,snapshot(d.id,'a'.repeat(64)));await put(b,snapshot(b.id,'a'.repeat(64)));expect(await get()).toHaveLength(1);
 await put(b,snapshot(b.id,'b'.repeat(64),2));expect(await get()).toHaveLength(2);
 const second=snapshot(d.id,'a'.repeat(64),2,'2026-09-11');await put(d,second);await put(d,second);
 expect((await get()).find((v:any)=>v.deviceId===d.id).history.dailyUsageBuckets).toHaveLength(2);
 const failed=snapshot(d.id,'a'.repeat(64),3);failed.quota.status='error';failed.quota.errorCode='ACCOUNT_FAILED';failed.quota.collectedAt=null;failed.quota.buckets=[];failed.history=null;failed.historyCollectedAt=null;await put(d,failed);
 const old=(await get()).find((v:any)=>v.deviceId===d.id);expect(old.stale).toBe(true);expect(old.quota.buckets).toHaveLength(1);expect(old.history.dailyUsageBuckets).toHaveLength(2);
 await put(d,snapshot(d.id,null,4));await put(b,snapshot(b.id,null,3));const unknown=await get();expect(unknown).toHaveLength(2);expect(unknown.every((v:any)=>v.quota.accountRef===null&&v.history===null)).toBe(true);
 await env.DB.prepare('UPDATE devices SET next_upload_at=0 WHERE id=?').bind(d.id).run();
 expect((await req('/api/v2/sync/accounts',d.credential,'PUT',snapshot(d.id,'c'.repeat(64),2),true)).status).toBe(409);
 expect((await get()).find((v:any)=>v.deviceId===d.id).quota.accountRef).toBeNull();
 const other=await actor();expect((await (await req('/api/v2/accounts',other.session)).json<any>()).accounts).toEqual([]);
});
it('rejects extra private fields and conflicting chunks and retains revision metadata until bounded deletion has reclaimed every record',async()=>{
 const a=await actor(),d=await device(a.user,'large'),t=fixture.devices.A.threads[0] as SyncThread,template=fixture.devices.A.events[0] as SyncEvent;
 const events=Array.from({length:1101},(_,i)=>({...template,event_key:'large:'+i,response_id:'large:'+i,total_tokens:'1',input_tokens:'1'}));
 const m=await upload(d,t,events);const bad={manifest:{...m,revision:2},index:0,events:[{...events[0],message:'NEVER-UPLOAD'}]};
 expect((await req('/api/v2/sync/chunks',d.credential,'PUT',bad,true)).status).toBe(400);
 expect((await req('/api/v2/sync/chunks',d.credential,'PUT',{manifest:m,index:0,events:[events[0]]},true)).status).toBe(409);
 await req('/api/v2/devices/'+d.id+'/history',a.session,'DELETE');
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM usage_records WHERE device_id=?').bind(d.id).first('n')).toBe(101);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM usage_revisions WHERE device_id=?').bind(d.id).first('n')).toBe(1);
 await cleanupUsage(env,d.id);expect(await env.DB.prepare('SELECT COUNT(*) n FROM usage_records WHERE device_id=?').bind(d.id).first('n')).toBe(0);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM usage_revisions WHERE device_id=?').bind(d.id).first('n')).toBe(0);
});
