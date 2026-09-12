import {MatchingRequest} from './matching-build';
import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import worker from '../src/index';
import {SESSION_COOKIE,sha256,token} from '../src/http';
import {advanceJobs} from '../src/v3/jobs';
import {stableJson,V3_CONTENT_TYPE,type UploadBatch} from '../../shared/sync-v3';
import fixture from '../.generated/billing.json';

const origin='https://quota.esoren.com';
it('ingests current native mode evidence, preserves pinned cuts, and switches subscription/API billing without changing tokens',async()=>{
  const user=crypto.randomUUID(),session=token(),credential=token();
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'billing-test',Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol) VALUES(?,?,?,?,?,3)').bind(fixture.device,user,'Billing fixture',await sha256(credential),Date.now()).run();
  const call=(route:string,method='GET',body?:unknown)=>worker.fetch(new MatchingRequest(origin+route,{method,
    headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+session,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const drain=async()=>{for(let i=0;i<80;i++){
    await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(user).run();
    if(!(await advanceJobs(env.DB,{user,maxSteps:1,budgetMs:10000})).steps)return;
  }throw Error('billing jobs did not finish');};
  const send=async(batch:UploadBatch)=>{
    const response=await worker.fetch(new MatchingRequest(origin+'/api/v3/ingest',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':V3_CONTENT_TYPE},body:gzipSync(stableJson(batch))}),env);
    expect([200,202]).toContain(response.status);await drain();
  };
  const summary=async(lease?:string)=>{
    const response=await call('/api/v3/usage/local/summary'+(lease?'?lease_id='+lease:''));expect(response.status).toBe(200);return (await response.json<any>()).data;
  };
  const pin=async()=>{const response=await call('/api/v3/sync/read','POST',{scope:'full'});expect(response.status).toBe(201);return response.json<any>();};
  for(const batch of fixture.batches)await send(batch as UploadBatch);
  expect((await call('/api/v3/settings','PATCH',{costEnabled:true})).status).toBe(200);
  expect(await summary()).toEqual(fixture.expected.subscription);
  const subscription=await pin();
  expect((await call('/api/v3/settings','PATCH',{officialApiPricing:true})).status).toBe(200);
  const api=await pin();expect(api.cut.config_version).toBeGreaterThan(subscription.cut.config_version);
  expect(await summary(api.lease_id)).toEqual(fixture.expected.api);
  expect(await summary(subscription.lease_id)).toEqual(fixture.expected.subscription);
  await send(fixture.batches[0] as UploadBatch);expect(await summary()).toEqual(fixture.expected.api);
  expect((await call('/api/v3/settings','PATCH',{officialApiPricing:false})).status).toBe(200);
  expect(await summary()).toEqual(fixture.expected.subscription);
  const prices=await (await call('/api/v3/usage/pricing')).json<any>();
  expect(prices.data.subscription.currency).toBe('USD');expect(prices.data.currency).toBe('USD');
});
