import {gzipSync} from 'node:zlib';
import { stableJson } from '../../modules/contracts/sync.js';
import {hashBytes} from '../../modules/sync/apply/codec.js';
import {MatchingRequest} from './matching-build';
import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import worker from '../../apps/cloud/index.js';
import {SESSION_COOKIE} from '../../modules/platform/worker/http.js';
import {domain,currentDevice,receive} from '../../modules/sync/publication/store.js';
import {queryBudget} from '../../modules/sync/jobs/query-budget.js';
import {actor,call,batch,origin} from './performance-fixture';

it('returns persisted v3 status before background work completes',async()=>{
  const a=await actor(),b=await batch(a),wire=gzipSync(stableJson(b));await receive(env.DB,await currentDevice(env.DB,a.user,a.device),b,wire,await hashBytes(wire));
  let unblock!:()=>void,claimed=false;
  const blocked=new Promise<void>(resolve=>{unblock=resolve;}),pending:Promise<unknown>[]=[];
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return (sql:string)=>{
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,method){
        if(method==='bind')return (...args:unknown[])=>wrap(target.bind(...args));
        if(method==='first'&&sql.includes('UPDATE v3_jobs SET state=\'running\''))return async(...args:unknown[])=>{
          claimed=true;await blocked;return (target.first as (...args:unknown[])=>Promise<unknown>)(...args);
        };
        const value=Reflect.get(target,method);return typeof value==='function'?value.bind(target):value;
      }});return wrap(target.prepare(sql));
    };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const ctx={waitUntil(promise:Promise<unknown>){pending.push(promise);},passThroughOnException(){},props:{}} as ExecutionContext;
  try{
    const response=await worker.fetch(new MatchingRequest(origin+'/api/v3/sync/status',{headers:{Cookie:SESSION_COOKIE+'='+a.session}}),{...env,DB:db},ctx);
    expect(response.status).toBe(200);expect(claimed).toBe(true);expect(pending).toHaveLength(1);
    const status=await response.json<any>();expect(status.user_id).toBe(a.user);
    expect(status.baseline_ready).toBe(true);expect(status.coverage.pending_batches).toHaveLength(1);
    expect(await env.DB.prepare('SELECT attempts FROM v3_jobs WHERE user_id=?').bind(a.user).first<number>('attempts')).toBe(0);
  }finally{unblock();await Promise.all(pending);}
  expect(await env.DB.prepare('SELECT attempts FROM v3_jobs WHERE user_id=?').bind(a.user).first<number>('attempts')).toBeGreaterThan(0);
});

it('labels account snapshots with the authenticated user for browser cache isolation',async()=>{
  const a=await actor(),b=await actor();
  const [first,second]=await Promise.all([call(a,'/api/v3/accounts'),call(b,'/api/v3/accounts')]);
  expect(await first.json()).toEqual({user_id:a.user,accounts:[]});
  expect(await second.json()).toEqual({user_id:b.user,accounts:[]});
});

it('keeps scheduled jobs plus the maximum 100-domain cleanup within one invocation budget',async()=>{
  const users=Array.from({length:100},()=>crypto.randomUUID()),raw=JSON.stringify(users),now=Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,github_id,login,created_at) SELECT value,value,'cron-budget',? FROM json_each(?)").bind(now,raw),
    env.DB.prepare('INSERT INTO v3_sync_domains(user_id,active_epoch,commit_seq,updated_at) SELECT value,value,1,? FROM json_each(?)').bind(now,raw),
    env.DB.prepare('INSERT INTO v3_commits(user_id,epoch,commit_seq,created_at,entity_count) SELECT value,value,1,?,0 FROM json_each(?)').bind(now-8*86400_000,raw),
    env.DB.prepare("INSERT INTO devices(id,user_id,name,token_hash,bound_at,revoked_at,history_deleted_at) SELECT value,value,'test',value,?,?,? FROM json_each(?)").bind(now,now,now,raw),
    env.DB.prepare("INSERT INTO v3_jobs(user_id,job_id,kind,device_id,payload,created_at,updated_at) SELECT value,'delete:'||value,'delete_device',value,'{}',?,? FROM json_each(?)").bind(now,now,raw),
  ]);
  const counted=queryBudget(env.DB,1001);
  await worker.scheduled({} as ScheduledController,{...env,DB:counted.db});
  expect(counted.stats.queries).toBeLessThanOrEqual(923);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_jobs WHERE state='complete'").first<number>('n')).toBeGreaterThan(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM v3_jobs WHERE state='pending'").first<number>('n')).toBeGreaterThan(0);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_commits').first<number>('n')).toBe(0);
});
