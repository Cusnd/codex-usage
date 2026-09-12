import {matchingDevice,MatchingRequest} from './matching-build';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../../apps/cloud/index.js';
import { SESSION_COOKIE,sha256,token } from '../../modules/platform/worker/http.js';
import type { CloudAccountSnapshot } from '../../modules/contracts/cloud-accounts.js';

const origin='https://quota.esoren.com';
async function actor(){const user=crypto.randomUUID(),session=token();await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'fixture-user',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();return {user,session};}
async function device(user:string,name:string){const id=crypto.randomUUID(),credential=token();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol) VALUES(?,?,?,?,?,2)').bind(id,user,name,await sha256(credential),Date.now()).run();await matchingDevice(env.DB,id);return {id,credential};}
async function req(path:string,session:string,method='GET',body?:unknown,bearer=false){return worker.fetch(new MatchingRequest(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+session}:{Cookie:SESSION_COOKIE+'='+session})},body:body===undefined?undefined:JSON.stringify(body)}),env);}
it('adds multiple bindings without replacement and gives collectors a common account key unavailable to browser sessions',async()=>{
 const a=await actor(),d=await device(a.user,'existing'),secret=token();
 const start=await req('/api/v3/device-authorizations',a.session,'POST',{deviceName:'second',tokenHash:await sha256(secret)});const p=await start.json<any>();expect(start.status).toBe(201);
 expect((await req('/api/v3/device-authorizations/approve',a.session,'POST',{code:p.userCode,replaceDeviceId:null})).status).toBe(200);
 await req('/api/v3/collector/handshake',secret,'POST',undefined,true);
 const list=await (await req('/api/v3/devices',a.session)).json<any>();expect(list.devices).toHaveLength(2);
 const one=await (await req('/api/v3/collector/config',d.credential,'GET',undefined,true)).json<any>(),two=await (await req('/api/v3/collector/config',secret,'GET',undefined,true)).json<any>();expect(one.accountKey).toBe(two.accountKey);
 expect((await req('/api/v3/collector/config',a.session)).status).toBe(401);
});
it('deduplicates confirmed accounts, separates unknown devices, preserves failed snapshots and historical days, and stops showing the old account after switching',async()=>{
 const a=await actor(),d=await device(a.user,'A'),b=await device(a.user,'B');
 const snapshot=(id:string,ref:string|null,sequence=1,day='2026-09-10'):CloudAccountSnapshot=>({schemaVersion:3,quota:{schemaVersion:3,deviceId:id,sequence,accountRef:ref,
   collectedAt:ref?'2026-09-11T00:00:00.000Z':null,attemptedAt:'2026-09-11T00:00:00.000Z',provider:ref?'app-server':null,refreshInterval:300,status:ref?'ok':'identity_unknown',errorCode:ref?null:'IDENTITY_UNKNOWN',buckets:ref?[{id:'codex',name:'Codex',primary:{usedPercent:30,remainingPercent:70,windowDurationMins:300,resetsAt:null},secondary:null}]:[]},
   history:ref?{summary:{lifetimeTokens:'9007199254740993',peakDailyTokens:null,longestRunningTurnSec:null,currentStreakDays:null,longestStreakDays:null},dailyUsageBuckets:[{startDate:day,tokens:'9007199254740993'}]}:null,historyCollectedAt:ref?'2026-09-11T00:00:00.000Z':null});
 const put=async(dev:typeof d,p:CloudAccountSnapshot)=>{await env.DB.prepare('UPDATE devices SET next_upload_at=0 WHERE id=?').bind(dev.id).run();const r=await req('/api/v3/accounts/observations',dev.credential,'PUT',p,true);expect(r.status,JSON.stringify(await r.json())).toBe(200);};
 const get=async()=> (await (await req('/api/v3/accounts',a.session)).json<any>()).accounts;
 await put(d,snapshot(d.id,'a'.repeat(64)));await put(b,snapshot(b.id,'a'.repeat(64)));expect(await get()).toHaveLength(1);
 await put(b,snapshot(b.id,'b'.repeat(64),2));expect(await get()).toHaveLength(2);
 const second=snapshot(d.id,'a'.repeat(64),2,'2026-09-11');await put(d,second);await put(d,second);
 expect((await get()).find((v:any)=>v.deviceId===d.id).history.dailyUsageBuckets).toHaveLength(2);
 const failed=snapshot(d.id,'a'.repeat(64),3);failed.quota.status='error';failed.quota.errorCode='ACCOUNT_FAILED';failed.quota.collectedAt=null;failed.quota.buckets=[];failed.history=null;failed.historyCollectedAt=null;await put(d,failed);
 const old=(await get()).find((v:any)=>v.deviceId===d.id);expect(old.stale).toBe(true);expect(old.quota.buckets).toHaveLength(1);expect(old.history.dailyUsageBuckets).toHaveLength(2);
 await put(d,snapshot(d.id,null,4));await put(b,snapshot(b.id,null,3));const unknown=await get();expect(unknown).toHaveLength(2);expect(unknown.every((v:any)=>v.quota.accountRef===null&&v.history===null)).toBe(true);
 await env.DB.prepare('UPDATE devices SET next_upload_at=0 WHERE id=?').bind(d.id).run();
 expect((await req('/api/v3/accounts/observations',d.credential,'PUT',snapshot(d.id,'c'.repeat(64),2),true)).status).toBe(409);
 expect((await get()).find((v:any)=>v.deviceId===d.id).quota.accountRef).toBeNull();
 const other=await actor();await device(other.user,'empty');expect((await (await req('/api/v3/accounts',other.session)).json<any>()).accounts).toEqual([]);
});
