import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import worker from '../../apps/cloud/index.js';
import { SESSION_COOKIE, sha256, token } from '../../modules/platform/worker/http.js';
import { SYNC_HEADER, SYNC_VERSION, BUILD_HEADER, BUILD_VERSION } from '../../modules/contracts/cloud-version.js';
import { stableJson, V3_CONTENT_TYPE } from '../../modules/contracts/sync.js';
import { batch } from './performance-fixture';

const origin = 'https://quota.esoren.com';
async function fixture() {
  const user = crypto.randomUUID(), device = crypto.randomUUID(), session = token(), credential = token();
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'version-test',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(device,user,'Laptop',await sha256(credential),Date.now()).run();
  const actor = {user,device,session,credential,collector:crypto.randomUUID()};
  async function call(path:string, options:{version?:string|null; sourceBuild?:string; machine?:boolean; method?:string; body?:BodyInit;contentType?:string}={}) {
    const version = options.version===undefined?SYNC_VERSION:options.version;
    return worker.fetch(new Request(origin+path,{method:options.method||'GET',body:options.body,headers:{Origin:origin,
      ...(options.machine?{Authorization:'Bearer '+credential}:{Cookie:SESSION_COOKIE+'='+session}),
      ...(version===null?{}:{[SYNC_HEADER]:version}),...(options.sourceBuild?{[BUILD_HEADER]:options.sourceBuild}:{}),...(options.contentType?{'Content-Type':options.contentType}:{})}}),env);
  }
  const handshake=(version:string|null=SYNC_VERSION)=>call('/api/v3/collector/handshake',{method:'POST',machine:true,version});
  return {...actor,call,handshake};
}

it('locks historical data and all panel routes until an authenticated matching collector reports',async()=>{
  const f=await fixture();
  const compatibility=await (await f.call('/api/v3/compatibility')).json<any>();
  expect(compatibility).toMatchObject({compatible:false,requiredVersion:SYNC_VERSION,devices:[{id:f.device,syncVersion:null,compatible:false}]});
  for(const route of ['/api/v3/usage/local/summary','/api/v3/accounts','/api/v3/settings','/api/v3/sync/status','/api/v3/sync/changes']) {
    const response=await f.call(route);expect(response.status,route).toBe(426);expect((await response.json<any>()).error.code).toBe('VERSION_MISMATCH');
  }
  expect((await f.call('/api/v3/me')).status).toBe(200);
  expect((await f.call('/api/v3/devices')).status).toBe(200);
  expect((await f.handshake()).status).toBe(200);
  expect((await (await f.call('/api/v3/compatibility')).json<any>()).compatible).toBe(true);
  expect((await f.call('/api/v3/accounts')).status).toBe(200);
});

it('rejects absent, older and newer protocols before decoding or receiving a batch, and retains data on downgrade',async()=>{
  const f=await fixture();
  for(const version of [null,'3.1.1','3.1.3']) {
    const response=await f.call('/api/v3/ingest',{machine:true,method:'POST',version,body:'invalid compressed data',contentType:V3_CONTENT_TYPE});
    expect(response.status).toBe(426);expect(response.headers.get(SYNC_HEADER)).toBe(SYNC_VERSION);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_receipts WHERE user_id=?').bind(f.user).first('n')).toBe(0);
  }
  const b=await batch(f),wire=gzipSync(stableJson(b));
  expect((await f.call('/api/v3/ingest',{machine:true,method:'POST',body:wire,contentType:V3_CONTENT_TYPE})).status).toBe(200);
  const read=await f.call('/api/v3/usage/local/summary');expect((await read.json<any>()).data.totalTokens).toBe('100');
  expect((await f.handshake('3.1.1')).status).toBe(426);
  expect((await f.call('/api/v3/usage/local/summary')).status).toBe(426);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_receipts WHERE user_id=?').bind(f.user).first('n')).toBe(1);
  await f.handshake();expect((await (await f.call('/api/v3/usage/local/summary')).json<any>()).data.totalTokens).toBe('100');
});

it('requires all active devices including paused devices, without allowing a device filter to bypass the lock',async()=>{
  const f=await fixture();await f.handshake();
  const device=crypto.randomUUID();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,paused) VALUES(?,?,?,?,?,1)').bind(device,f.user,'Older laptop',token(),Date.now()).run();
  expect((await f.call('/api/v3/accounts?deviceIds='+f.device)).status).toBe(426);
  const state=await (await f.call('/api/v3/compatibility')).json<any>();expect(state.devices.filter((d:any)=>!d.compatible).map((d:any)=>d.id)).toEqual([device]);
  // Revocation is a user action, not an automatic side effect of version rejection.
  expect((await f.call('/api/v3/devices/'+device,{method:'DELETE'})).status).toBe(200);
  expect((await f.call('/api/v3/accounts')).status).toBe(200);
});

it('does not reuse an old matching registration after a protocol change, and rejects stale browsers',async()=>{
  const f=await fixture();await env.DB.prepare('INSERT INTO device_sync_versions VALUES(?,?,?)').bind(f.device,'3.1.1',Date.now()).run();
  expect((await f.call('/api/v3/accounts')).status).toBe(426);await f.handshake();
  for(const version of [null,'3.1.1'])expect((await f.call('/api/v3/accounts',{version})).status).toBe(426);
  expect((await f.call('/api/v3/accounts')).status).toBe(200);
});

it('retires old upload and fallback query endpoints even when the caller supplies the current protocol',async()=>{
  const f=await fixture();await f.handshake();
  for(const path of ['/api/v2/sync/chunks','/api/v2/sync/commit','/api/v2/sync/accounts','/api/v1/snapshot']) {
    expect((await f.call(path,{machine:true,method:'PUT',body:'{}',contentType:'application/json'})).status,path).toBe(404);
  }
  for(const path of ['/api/v2/usage/local/summary?legacy_fallback=1','/api/v2/accounts','/api/v1/quota','/api/v3/legacy/prepare'])expect((await f.call(path)).status,path).toBe(404);
});

it('does not disclose device versions without a session or let an invalid credential report a version',async()=>{
  const f=await fixture();
  expect((await worker.fetch(new Request(origin+'/api/v3/compatibility'),env)).status).toBe(401);
  expect((await worker.fetch(new Request(origin+'/api/v3/collector/handshake',{method:'POST',headers:{Authorization:'Bearer invalid',[SYNC_HEADER]:SYNC_VERSION}}),env)).status).toBe(401);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM device_sync_versions WHERE device_id=?').bind(f.device).first('n')).toBe(0);
});

it('requires a new version handshake after a device credential is replaced',async()=>{
  const f=await fixture();await f.handshake();
  await env.DB.prepare('UPDATE devices SET token_hash=? WHERE id=?').bind(await sha256(token()),f.device).run();
  expect((await f.call('/api/v3/accounts')).status).toBe(426);
  expect((await f.handshake()).status).toBe(401);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM device_sync_versions WHERE device_id=?').bind(f.device).first('n')).toBe(0);
});

it('rejects old extractor packets and migration metadata even with the matching synchronization protocol',async()=>{
  const f=await fixture(),current=await batch(f);
  const retired=[{...current,extractor_version:1},{...current,metadata:[{type:'legacy_replacement',dataset_id:'old',thread_id:'thread',sources:[{source_id:'source',generation:1}]}]}];
  for(const input of retired){
    const response=await f.call('/api/v3/ingest',{machine:true,method:'POST',body:gzipSync(stableJson(input)),contentType:V3_CONTENT_TYPE});
    expect(response.status).toBe(400);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_receipts WHERE user_id=?').bind(f.user).first('n')).toBe(0);
  expect((await f.call('/api/v3/ingest',{machine:true,method:'POST',body:gzipSync(stableJson(current)),contentType:V3_CONTENT_TYPE})).status).toBe(200);
});

it('initializes current storage without retired tables or migration jobs',async()=>{
  const names=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results.map(r=>r.name);
  for(const name of ['quota_snapshots','usage_heads','usage_records','usage_chunks','usage_revisions','v3_legacy_heads','v3_legacy_pending_sources'])expect(names).not.toContain(name);
  const f=await fixture();await f.handshake();
  expect((await f.call('/api/v3/sync/status')).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_jobs WHERE kind LIKE 'legacy%'").first('n')).toBe(0);
});

it('serves browser date filters directly through v3 without registration from a retired reader',async()=>{
  const f=await fixture(),b=await batch(f);
  expect((await f.call('/api/v3/ingest',{machine:true,method:'POST',body:gzipSync(stableJson(b)),contentType:V3_CONTENT_TYPE})).status).toBe(200);
  const params=new URLSearchParams({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),timezone:'America/New_York'});
  for(const route of ['local/summary','local/trend','local/filters'])expect((await f.call('/api/v3/usage/'+route+'?'+params)).status,route).toBe(200);
  params.set('from','invalid');expect((await f.call('/api/v3/usage/local/summary?'+params)).status).toBe(400);
});


it('allows a different source fingerprint when the current protocol matches',async()=>{
  const f=await fixture();
  for(const sourceBuild of [undefined,'0.1.6+ui-only-change','0.2.0+internal-optimization']) {
    expect((await f.call('/api/v3/collector/handshake',{method:'POST',machine:true,sourceBuild})).status).toBe(200);
    const response=await f.call('/api/v3/accounts',{sourceBuild});
    expect(response.status).toBe(200);expect(response.headers.get(BUILD_HEADER)).toBe(BUILD_VERSION);
    expect(response.headers.get(SYNC_HEADER)).toBe(SYNC_VERSION);
  }
  const wrong=await f.call('/api/v3/collector/handshake',{method:'POST',machine:true,version:'3.1.1',sourceBuild:BUILD_VERSION});
  expect(wrong.status).toBe(426);
});
