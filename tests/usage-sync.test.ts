import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/db.js';
import { UsageSync } from '../server/usage-sync.js';
import { SYNC_BODY_BYTES, validChunk, type SyncChunk } from '../shared/usage-sync.js';
import type { LimitObservation } from '../server/refresh.js';

const at='2026-09-11T00:00:00.000Z';
const observation=(key='private-user'):LimitObservation=>({stableIdentity:key,identityKey:key,identityKnown:true,
  data:{accountId:'private-workspace',buckets:[]},provider:'app-server',collectedAt:at,attemptedAt:at,errorCode:null,refreshInterval:300});
function fixture(count=450,project='/private/full/path'){
  const dir=mkdtempSync(path.join(os.tmpdir(),'usage-sync-')),file=path.join(dir,'usage.sqlite');let store=new Store(file),now=Date.parse(at),reading=observation();
  store.run('INSERT INTO threads(id,title,project) VALUES(?,?,?)',['thread','原标题',project]);
  for(let i=0;i<count;i++)store.run(`INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,kind,incomplete,active,input_tokens,total_tokens)
    VALUES(?,?,?,?,?,?,?,?,?,0,1,?,?)`,['PRIVATE-RAW-ROLLOUT','response:'+i,'thread','turn:'+i,''+i,at,project,'gpt-6-astra','record',9007199254740993n,9007199254740993n]);
  const calls:{route:string;body:any}[]=[],chunks=new Map<string,string>();let fail=false,conflict=false,paused=false;
  const transport=async(route:string,_method:string,body?:any)=>{calls.push({route,body:structuredClone(body)});let response=Response.json({ok:true});
    if(route==='sync/config')response=Response.json({accountKey:'k'.repeat(43),paused});
    if(route==='sync/chunks'){
      assert(validChunk(body));assert(Buffer.byteLength(JSON.stringify(body))<=SYNC_BODY_BYTES);
      if(conflict){conflict=false;return {response:Response.json({error:{code:'STALE_SEQUENCE'},acceptedSequence:99},{status:409}),data:{error:{code:'STALE_SEQUENCE'},acceptedSequence:99}};}
      const c=body as SyncChunk,k=c.manifest.revision+':'+c.index,raw=JSON.stringify(c);assert(!chunks.has(k)||chunks.get(k)===raw);chunks.set(k,raw);
      if(fail&&c.index===1){fail=false;throw new Error('PRIVATE-TRANSPORT-BODY');}
    }
    return {response,data:await response.clone().json() as Record<string,any>};
  };
  const make=()=>new UsageSync(store,transport,async()=>reading,undefined,()=>now,()=>({running:false,updatedAt:at,error:null}));let sync=make();
  return {get store(){return store;},get sync(){return sync;},calls,chunks,advance:(ms=60001)=>now+=ms,
    fail:()=>{fail=true;},conflict:()=>{conflict=true;},paused:(v:boolean)=>{paused=v;},reading:(v:LimitObservation)=>{reading=v;},
    restart(){store.close();store=new Store(file);sync=make();},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('persists immutable chunks across interrupted acknowledgements and restart, then replaces corrected history',async()=>{
  const f=fixture();try{f.fail();await f.sync.tick('device',()=>true);assert.equal(f.sync.status().pendingThreads,1);assert.equal(f.calls.filter(c=>c.route==='sync/commit').length,0);
    const original=f.calls.find(c=>c.route==='sync/chunks')!.body;
    f.store.run('UPDATE usage_events SET total_tokens=100 WHERE event_key=?',['response:0']);
    f.restart();f.advance();await f.sync.tick('device',()=>true);assert.equal(f.sync.status().pendingThreads,0);
    assert.equal(f.calls.find(c=>c.route==='sync/commit')!.body.contentHash,original.manifest.contentHash);
    f.advance();await f.sync.tick('device',()=>true);assert.equal(f.calls.filter(c=>c.route==='sync/commit').at(-1)!.body.revision,2);
    const correction=f.calls.filter(c=>c.route==='sync/chunks').find(c=>c.body.manifest.revision===2)!.body;
    assert.equal(correction.events[0].total_tokens,'100');assert.equal(correction.events[1].total_tokens,'9007199254740993');
    const wire=JSON.stringify(f.calls);assert(!/PRIVATE-RAW-ROLLOUT|PRIVATE-TRANSPORT-BODY|private-user|private-workspace/.test(wire));assert(wire.includes('原标题'));assert(wire.includes('/private/full/path'));
  }finally{f.close();}
});
test('chunks long UTF-8 project paths by bytes and recovers stale usage revisions independently of account sequence',async()=>{
  const f=fixture(40,'/'+ '项目'.repeat(2000));try{f.conflict();await f.sync.tick('device',()=>true);f.advance();await f.sync.tick('device',()=>true);
    for(let i=0;i<5&&f.sync.status().pendingThreads;i++){f.advance(2000);await f.sync.tick('device',()=>true);}
    assert.equal(f.calls.find(c=>c.route==='sync/commit')!.body.revision,100);assert.equal(f.calls.find(c=>c.route==='sync/accounts')!.body.quota.sequence,1);
    assert.equal(f.sync.status().pendingThreads,0);assert(f.calls.filter(c=>c.route==='sync/chunks').length>2);
  }finally{f.close();}
});
test('cloud pause and caller cancellation stop uploads; rebinding republishes complete history under the new device',async()=>{
  const f=fixture(1);try{f.paused(true);await f.sync.tick('first',()=>true);assert(!f.calls.some(c=>c.route==='sync/chunks'));
    f.paused(false);f.advance();await f.sync.tick('first',()=>false);assert(!f.calls.some(c=>c.route==='sync/chunks'));
    await f.sync.tick('first',()=>true);f.advance();await f.sync.tick('second',()=>true);assert.equal(f.calls.filter(c=>c.route==='sync/commit').length,2);
  }finally{f.close();}
});
test('uses the common account key only for confirmed stable identity and replaces account selection after switching',async()=>{
  const f=fixture(0);try{await f.sync.tick('one',()=>true);const ref=f.calls.find(c=>c.route==='sync/accounts')!.body.quota.accountRef;
    f.advance();await f.sync.tick('two',()=>true);assert.equal(f.calls.filter(c=>c.route==='sync/accounts').at(-1)!.body.quota.accountRef,ref);
    f.reading(observation('second-private-user'));f.advance();await f.sync.tick('two',()=>true);assert.notEqual(f.calls.filter(c=>c.route==='sync/accounts').at(-1)!.body.quota.accountRef,ref);
    f.reading({...observation(),stableIdentity:null});f.advance();await f.sync.tick('two',()=>true);const q=f.calls.filter(c=>c.route==='sync/accounts').at(-1)!.body.quota;
    assert.equal(q.status,'identity_unknown');assert.equal(q.accountRef,null);assert.deepEqual(q.buckets,[]);
  }finally{f.close();}
});
