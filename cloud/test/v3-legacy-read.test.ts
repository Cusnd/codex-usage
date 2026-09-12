import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import worker from '../src/index';
import {legacyReadAvailable} from '../src/v3/legacy-read';
import {SESSION_COOKIE} from '../src/http';
import {stableJson} from '../../shared/sync-v3';
import {domain,currentDevice,receive} from '../src/v3/store';
import {hashBytes} from '../src/v3/codec';
import {origin,actor,batch,call,legacy,drain} from './performance-fixture';it('serves the full committed old history during first migration without pretending a v3 cut',async()=>{
  const a=await actor();await legacy(a,'9007199254740993');await domain(env.DB,a.user);
  expect(await legacyReadAvailable(env.DB,a.user)).toBe(true);
  const read=await call(a,'/api/v3/sync/read','POST',{scope:'full'});expect(read.status).toBe(409);
  const response=await call(a,'/api/v2/usage/local/summary?legacy_fallback=1');expect(response.status).toBe(200);
  const body=await response.json<any>();expect(body.data.totalTokens).toBe('9007199254740993');expect(body.meta.legacyView).toEqual({complete:true,user_id:a.user});expect(body.meta.cut).toBeUndefined();
  const other=await actor();await domain(env.DB,other.user);expect((await call(other,'/api/v2/usage/local/summary?legacy_fallback=1')).status).toBe(409);
  expect((await call(a,'/api/v2/usage/settings?legacy_fallback=1','PATCH',{costEnabled:true})).status).toBe(405);
  await drain(a);expect((await call(a,'/api/v2/usage/local/summary?legacy_fallback=1')).status).toBe(409);
});
it('does not call a mixed v2 and v3 history a complete compatibility view',async()=>{
  const a=await actor();await legacy(a,'100');await domain(env.DB,a.user);
  const b=await batch(a),wire=gzipSync(stableJson(b));await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
  expect(await legacyReadAvailable(env.DB,a.user)).toBe(true);
  await env.DB.prepare("UPDATE v3_receipts SET status='applied' WHERE user_id=?").bind(a.user).run();
  expect(await legacyReadAvailable(env.DB,a.user)).toBe(false);
});
it('invalidates a compatibility response if deletion starts while its queries are in flight',async()=>{
  const a=await actor();await legacy(a,'100');await domain(env.DB,a.user);let triggered=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const wrap=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(statement,method){if(method==='bind')return (...args:unknown[])=>wrap(statement.bind(...args));if(method==='all')return async()=>{const value=await statement.all();if(!triggered&&sql.includes('WITH selected AS')){triggered=true;await env.DB.prepare("UPDATE devices SET history_deleted_at=? WHERE user_id=?").bind(Date.now(),a.user).run();}return value;};return Reflect.get(statement,method);}});return wrap(target.prepare(sql));};return Reflect.get(target,key);}});
  const response=await worker.fetch(new Request(origin+'/api/v2/usage/local/summary?legacy_fallback=1',{headers:{Cookie:SESSION_COOKIE+'='+a.session}}),{...env,DB:db});
  expect(triggered).toBe(true);expect(response.status).toBe(409);expect((await response.json<any>()).error.code).toBe('LEGACY_VIEW_EXPIRED');
});
it('rejects a mixed pagination result when a new committed v2 head arrives between count and page',async()=>{
  const a=await actor();await legacy(a,'100');await domain(env.DB,a.user);let triggered=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const wrap=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(statement,method){if(method==='bind')return (...args:unknown[])=>wrap(statement.bind(...args));if(method==='all')return async()=>{
    const value=await statement.all();
    if(!triggered&&sql.includes('SELECT COUNT(*) n FROM (')&&sql.includes('GROUP BY thread_id')){
      triggered=true;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO usage_revisions(user_id,device_id,dataset_id,thread_id,revision,parser_version,collected_at,manifest,received_at,committed) SELECT user_id,device_id,dataset_id,'second-thread',revision,parser_version,collected_at,json_set(manifest,'$.thread.id','second-thread'),received_at,committed FROM usage_revisions WHERE user_id=? AND revision=1").bind(a.user),
        env.DB.prepare("INSERT INTO usage_records(user_id,device_id,dataset_id,thread_id,revision,event_key,turn_id,response_id,at,project,model,kind,incomplete,input_tokens,output_tokens,total_tokens) SELECT user_id,device_id,dataset_id,'second-thread',revision,'second-event',turn_id,'second-response',at,project,model,kind,incomplete,200,0,200 FROM usage_records WHERE user_id=? AND revision=1").bind(a.user),
        env.DB.prepare("INSERT INTO usage_heads(user_id,device_id,dataset_id,thread_id,revision) SELECT user_id,device_id,dataset_id,'second-thread',revision FROM usage_heads WHERE user_id=?").bind(a.user),
      ]);
    }return value;
  };return Reflect.get(statement,method);}});return wrap(target.prepare(sql));};return Reflect.get(target,key);}});
  const response=await worker.fetch(new Request(origin+'/api/v2/usage/local/threads?legacy_fallback=1',{headers:{Cookie:SESSION_COOKIE+'='+a.session}}),{...env,DB:db});
  const body=await response.json<any>();expect(triggered).toBe(true);
  expect(response.status,stableJson(body)).toBe(409);expect(body.error.code).toBe('LEGACY_VIEW_EXPIRED');
  const retry=await call(a,'/api/v2/usage/local/threads?legacy_fallback=1');const current=await retry.json<any>();
  expect(retry.status).toBe(200);expect(current.data.total).toBe(2);expect(current.data.items).toHaveLength(2);expect(current.meta.legacyView).toEqual({complete:true,user_id:a.user});
});
it('reports an expired legacy read if head replacement invalidates the integer safety proof before SUM',async()=>{
  const a=await actor();await legacy(a,'100');await domain(env.DB,a.user);let triggered=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const wrap=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(statement,method){if(method==='bind')return (...args:unknown[])=>wrap(statement.bind(...args));if(method==='all')return async()=>{
    const value=await statement.all();if(!triggered&&sql.includes('total_tokens_digits')){
      triggered=true;await legacy(a,'9223372036854775807',2);
      await env.DB.prepare("INSERT INTO usage_records(user_id,device_id,dataset_id,thread_id,revision,event_key,turn_id,response_id,at,project,model,kind,incomplete,input_tokens,output_tokens,total_tokens) SELECT user_id,device_id,dataset_id,thread_id,revision,'overflow-part',turn_id,'overflow-response',at,project,model,kind,incomplete,1,0,1 FROM usage_records WHERE user_id=? AND revision=2").bind(a.user).run();
    }return value;
  };return Reflect.get(statement,method);}});return wrap(target.prepare(sql));};return Reflect.get(target,key);}});
  const response=await worker.fetch(new Request(origin+'/api/v2/usage/local/summary?legacy_fallback=1',{headers:{Cookie:SESSION_COOKIE+'='+a.session}}),{...env,DB:db});
  expect(triggered).toBe(true);expect(response.status).toBe(409);expect((await response.json<any>()).error.code).toBe('LEGACY_VIEW_EXPIRED');
  const retry=await call(a,'/api/v2/usage/local/summary?legacy_fallback=1');expect(retry.status).toBe(200);expect((await retry.json<any>()).data.totalTokens).toBe('9223372036854775808');
});
