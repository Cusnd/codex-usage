import {MatchingRequest} from './matching-build';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import worker from '../src/index';
import { SESSION_COOKIE, sha256, token } from '../src/http';
import { initialContext, normalizeTokens } from '../../shared/usage-domain/normalize';
import { stableJson, V3_CONTENT_TYPE, type UploadBatch } from '../../shared/sync-v3';
import { advanceJobs } from '../src/v3/jobs';

const origin='https://quota.esoren.com';
async function fixture(){
  const user=crypto.randomUUID(),device=crypto.randomUUID(),session=token(),credential=token(),collector=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'device-method-test',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(device,user,'Method test',await sha256(credential),Date.now()).run();
  const context={...initialContext('method-session'),turn_id:'turn'},record={type:'token_usage_record' as const,timestamp:new Date().toISOString(),payload:{thread_id:'method-session',turn_id:'turn',response_id:'method-response',usage:normalizeTokens({input_tokens:20,output_tokens:0,total_tokens:20})}};
  const records:UploadBatch['records']=[{observation_id:await sha256(stableJson([collector,'source',1,0])),record_revision:1,source_id:'source',generation:1,locator:0,byte_end:100,prefix_hash:await sha256(stableJson(record)),session_trusted:true,origin:{kind:'execution',device_id:device},context,record}];
  const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:2,collector_id:collector,producer_epoch:'epoch',lane:'live',lane_seq:1,batch_id:crypto.randomUUID(),records_hash:await sha256(stableJson(records)),records,metadata:[],sources:[{source_id:'source',generation:1,kind:'session',from_cursor:0,to_cursor:100,snapshot_eof:100,context_hash:await sha256(stableJson(context)),context,replace_start:true,replace_end:true,generation_complete:true,available:true,trailing_bytes:0}]};
  const uploaded=await worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':V3_CONTENT_TYPE},body:gzipSync(stableJson(batch))}),env);
  expect([200,202]).toContain(uploaded.status);
  async function drain(){for(let i=0;i<30;i++){await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(user).run();if(!(await advanceJobs(env.DB,{user,maxSteps:1,budgetMs:10000})).steps)return;}throw Error('Fixture did not settle');}
  await drain();
  const call=(suffix:string,method:string,body?:unknown,headers:Record<string,string>={})=>worker.fetch(new MatchingRequest(origin+'/api/v3/devices/'+device+suffix,{method,headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+session,...body===undefined?{}:{'Content-Type':'application/json'},...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const state=()=>env.DB.prepare('SELECT paused,revoked_at,history_deleted_at,initial_complete FROM devices WHERE id=?').bind(device).first();
  const summary=async(expected=200)=>{const response=await worker.fetch(new MatchingRequest(origin+'/api/v3/usage/local/summary',{headers:{Cookie:SESSION_COOKIE+'='+session}}),env);expect(response.status).toBe(expected);return expected===200?(await response.json<{data:{totalTokens:string}}>()).data.totalTokens:null;};
  return{call,state,summary,drain};
}

it('rejects every non-DELETE history method without revoking or deleting retained usage',async()=>{
  const f=await fixture(),before=await f.state();expect(await f.summary()).toBe('20');
  for(const method of ['PATCH','POST','PUT','GET','HEAD','OPTIONS']){
    const response=await f.call('/history',method,['GET','HEAD'].includes(method)?undefined:{paused:true});
    expect(response.status,method).toBe(405);expect(response.headers.get('Allow')).toBe('DELETE');
    await f.drain();expect(await f.state(),method).toEqual(before);expect(await f.summary(),method).toBe('20');
  }
});

it('keeps normal pause, revoke and history deletion as separate authenticated actions',async()=>{
  const f=await fixture();
  expect((await f.call('','PATCH',{paused:true},{Origin:'https://untrusted.example'})).status).toBe(403);
  expect((await f.call('/history','DELETE',undefined,{Cookie:''})).status).toBe(401);
  expect(await f.state()).toMatchObject({paused:0,revoked_at:null,history_deleted_at:null});
  expect((await f.call('','PATCH',{paused:true})).status).toBe(200);
  expect(await f.state()).toMatchObject({paused:1,revoked_at:null,history_deleted_at:null});expect(await f.summary()).toBe('20');
  expect((await f.call('','PATCH',{paused:false})).status).toBe(200);
  expect((await f.call('','DELETE')).status).toBe(200);
  expect(await f.state()).toMatchObject({paused:0,revoked_at:expect.any(Number),history_deleted_at:null});await f.summary(426);
  expect([200,202]).toContain((await f.call('/history','DELETE')).status);await f.drain();
  expect(await f.state()).toMatchObject({revoked_at:expect.any(Number),history_deleted_at:expect.any(Number)});await f.summary(426);
});
