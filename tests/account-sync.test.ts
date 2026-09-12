import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { AccountSync } from '../server/account-sync.js';
import type { LimitObservation } from '../server/refresh.js';
const at='2026-09-11T00:00:00.000Z';
const observation=(key='private-user'):LimitObservation=>({stableIdentity:key,identityKey:key,identityKnown:true,data:{accountId:'private-workspace',buckets:[]},provider:'app-server',collectedAt:at,attemptedAt:at,errorCode:null,refreshInterval:300});
function fixture(){
  const store=new Store(':memory:');let now=Date.parse(at),reading=observation();const calls:{route:string;body:any}[]=[];
  const sync=new AccountSync(store,async(route,_method,body)=>{calls.push({route,body});return {response:Response.json({}),data:route==='collector/config'?{accountKey:'k'.repeat(43),paused:false}:{}};},async()=>reading,undefined,()=>now);
  return {sync,calls,advance:()=>now+=60001,reading:(value:LimitObservation)=>reading=value,close:()=>store.close()};
}
test('uses the common account key only for confirmed stable identity and replaces account selection after switching',async()=>{
  const f=fixture();try{await f.sync.tick('one',()=>true);const ref=f.calls.find(c=>c.route==='accounts/observations')!.body.quota.accountRef;
    f.advance();await f.sync.tick('two',()=>true);assert.equal(f.calls.filter(c=>c.route==='accounts/observations').at(-1)!.body.quota.accountRef,ref);
    f.reading(observation('second-private-user'));f.advance();await f.sync.tick('two',()=>true);assert.notEqual(f.calls.filter(c=>c.route==='accounts/observations').at(-1)!.body.quota.accountRef,ref);
    f.reading({...observation(),stableIdentity:null});f.advance();await f.sync.tick('two',()=>true);const q=f.calls.filter(c=>c.route==='accounts/observations').at(-1)!.body.quota;
    assert.equal(q.status,'identity_unknown');assert.equal(q.accountRef,null);assert.deepEqual(q.buckets,[]);
  }finally{f.close();}
});
