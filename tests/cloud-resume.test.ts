import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { AccountError, type AccountSource } from '../server/account.js';
import type { CloudAccountSnapshot } from '../shared/usage-sync.js';
import { Store } from '../server/db.js';
import { UsageSync } from '../server/usage-sync.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}
async function setup(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'cloud-resume-'));
  const identity={key:'synthetic-resume-account',accountId:'synthetic-account'};
  let used=20,reads=0,failed=false,paused=false,readGate:ReturnType<typeof deferred>|null=null;
  const entered=deferred(),trace:string[]=[],uploads:CloudAccountSnapshot[]=[];
  const account:AccountSource={selection:async()=>({identity,confirmed:true}),close(){readGate?.resolve();},async readLimits(){
    reads++;trace.push('read:'+used);if(readGate){entered.resolve();await readGate.promise;}
    if(failed)throw new AccountError('RPC_TIMEOUT','Synthetic account unavailable');
    return{identity,provider:'app-server',fallbackReason:null,data:{accountId:identity.accountId,buckets:[{id:'codex',name:'Codex',primary:{usedPercent:used,remainingPercent:100-used,windowDurationMins:300,resetsAt:null},secondary:null}]}};
  },async readUsage(){throw new AccountError('UNSUPPORTED_METHOD','History is outside this regression');}};
  const transport:typeof fetch=async(input,init)=>{
    const route=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    if(route.endsWith('/device-authorizations'))return Response.json({requestId:'resume-request',pollSecret:'p'.repeat(43),userCode:'ABCD-2345',expiresAt:new Date(Date.now()+600000).toISOString()},{status:201});
    if(route.endsWith('/device-authorizations/poll'))return Response.json({status:'approved',deviceId:'resume-device',deviceName:'Resume fixture',userLogin:'fixture'});
    if(route.endsWith('/sync/config'))return Response.json({accountKey:'k'.repeat(43),paused});
    if(route.endsWith('/sync/pause')){paused=body.paused;trace.push('paused:'+paused);return Response.json({ok:true});}
    if(route.endsWith('/accounts/observations')){uploads.push(body);trace.push('quota:'+body.quota.buckets[0]?.primary?.usedPercent);return Response.json({receivedAt:new Date().toISOString(),acceptedSequence:body.quota.sequence});}
    if(route.endsWith('/sync/status'))return Response.json({ok:true});
    throw Error('Unexpected transport route '+route);
  };
  const instance=await createApp({database:path.join(directory,'usage.sqlite'),codexHome:directory,startup:false,accountReader:account,cloudCredentialFile:null,cloudOrigin:'https://synthetic.example',cloudFetch:transport});
  instance.store.saveSettings({...instance.store.settings(),localInterval:0,accountInterval:0});
  const toggle=async(enabled:boolean)=>{const response=await instance.app.inject({method:'PATCH',url:'/api/cloud/settings',payload:{enabled}});assert.equal(response.statusCode,200,response.body);return response.json().data;};
  return{...instance,uploads,trace,entered,toggle,get reads(){return reads;},get paused(){return paused;},setUsed(value:number){used=value;},fail(){failed=true;},holdRead(){readGate=deferred();},releaseRead(){readGate?.resolve();},
    async bind(){await instance.refresh.refreshAccountLimits();const response=await instance.app.inject({method:'POST',url:'/api/cloud/connect',payload:{deviceName:'Resume fixture'}});assert.equal(response.statusCode,200);await instance.cloud.tick();assert.equal(uploads.at(-1)?.quota.buckets[0].primary?.usedPercent,20);},
    async close(){readGate?.resolve();await instance.app.close();await rm(directory,{recursive:true,force:true});}};
}

test('API resume reads current quota with automatic refresh disabled and uploads without waiting for the ordinary interval',async()=>{
  const f=await setup();try{
    await f.bind();assert.equal(f.reads,1);await f.toggle(false);await f.cloud.tick();assert.equal(f.paused,true);
    f.setUsed(70);const mark=f.trace.length;await f.toggle(true);await f.cloud.tick();
    assert.equal(f.reads,2);assert.equal(f.paused,false);assert.equal(f.uploads.at(-1)?.quota.buckets[0].primary?.usedPercent,70);
    const resumed=f.trace.slice(mark);assert(resumed.indexOf('read:70')<resumed.indexOf('paused:false'));assert(resumed.indexOf('paused:false')<resumed.indexOf('quota:70'));
    await f.toggle(true);await f.cloud.tick();assert.equal(f.reads,2,'an already-enabled settings save is not another resume');
  }finally{await f.close();}
});

test('failed current quota read resumes synchronization with the measured old value explicitly marked stale',async()=>{
  const f=await setup();try{
    await f.bind();const before=f.uploads[0].quota;await f.toggle(false);await f.cloud.tick();f.fail();
    await f.toggle(true);await f.cloud.tick();const after=f.uploads.at(-1)!.quota;
    assert.equal(f.reads,2);assert.equal(f.cloud.status().enabled,true);assert.equal(f.paused,false);
    assert.equal(after.status,'error');assert.equal(after.errorCode,'ACCOUNT_FAILED');assert.equal(after.collectedAt,before.collectedAt);assert.equal(after.buckets[0].primary?.usedPercent,20);
    const local=(await f.app.inject('/api/account/limits')).json();assert.equal(local.meta.stale,true);
  }finally{await f.close();}
});

test('a newer pause cancels activation while resume is waiting for the account read',async()=>{
  const f=await setup();try{
    await f.bind();await f.toggle(false);await f.cloud.tick();f.setUsed(70);f.holdRead();
    const resume=f.toggle(true);await f.entered.promise;assert.equal(f.cloud.status().enabled,false);
    await f.toggle(false);f.releaseRead();const result=await resume;await f.cloud.tick();
    assert.equal(result.enabled,false);assert.equal(f.cloud.status().enabled,false);assert.equal(f.paused,true);assert.equal(f.uploads.length,1);
  }finally{await f.close();}
});

test('explicit account refresh preserves a server Retry-After delay',async()=>{
  const store=new Store(':memory:');let now=Date.now(),attempts=0;
  const sync=new UsageSync(store,async(route)=>{
    if(route==='sync/config')return{response:Response.json({}),data:{accountKey:'k'.repeat(43),paused:false}};
    assert.equal(route,'sync/accounts');attempts++;
    return attempts===1?{response:Response.json({}, {status:429,headers:{'Retry-After':'120'}}),data:{error:{code:'SYNC_RATE_LIMITED'}}}:{response:Response.json({}),data:{}};
  },async()=>({stableIdentity:'account',identityKey:'account',identityKnown:true,data:{accountId:'account',buckets:[]},provider:'app-server',collectedAt:new Date(now).toISOString(),attemptedAt:new Date(now).toISOString(),errorCode:null,refreshInterval:0}),undefined,()=>now);
  try{
    await sync.tick('device',()=>true,'accounts');assert.equal(attempts,1);
    sync.refreshAccounts();await sync.tick('device',()=>true,'accounts');assert.equal(attempts,1);
    now+=119999;await sync.tick('device',()=>true,'accounts');assert.equal(attempts,1);
    now++;await sync.tick('device',()=>true,'accounts');assert.equal(attempts,2);assert.equal(sync.status().error,null);
  }finally{store.close();}
});
