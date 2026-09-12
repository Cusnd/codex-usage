import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { accountViews } from '../src/accounts';
import { deviceViews } from '../src/v3/devices';
import type { CloudAccountSnapshot } from '../../shared/cloud-accounts';

async function accountFixture() {
  const user=crypto.randomUUID(),now=Date.now(),account='account-'+user;
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'display-test',now).run();
  const at=(age:number)=>new Date(now-age).toISOString();
  async function add(name:string,options:{quotaAge?:number;historyAge?:number;receivedAge?:number;days?:[string,string][];tokens?:string;quotaError?:boolean;paused?:boolean;noHistory?:boolean}={}) {
    const device=crypto.randomUUID();
    await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,current_account_ref,paused) VALUES(?,?,?,?,?,?,?)').bind(device,user,name,device,now,account,Number(!!options.paused)).run();
    const payload:CloudAccountSnapshot={schemaVersion:3,quota:{schemaVersion:3,deviceId:device,sequence:1,accountRef:account,collectedAt:at(options.quotaAge??10000),attemptedAt:at(0),provider:'app-server',refreshInterval:60,status:options.quotaError?'error':'ok',errorCode:options.quotaError?'HTTP_NETWORK':null,buckets:[]},
      history:options.noHistory?null:{summary:{lifetimeTokens:options.tokens||'100',peakDailyTokens:'100',longestRunningTurnSec:'1',currentStreakDays:'1',longestStreakDays:'1'},dailyUsageBuckets:options.days?.map(([startDate,tokens])=>({startDate,tokens}))||null},historyCollectedAt:options.noHistory?null:at(options.historyAge??10000)};
    await env.DB.prepare('INSERT INTO cloud_accounts(user_id,device_id,account_ref,sequence,payload,received_at,request_hash) VALUES(?,?,?,1,?,?,?)').bind(user,device,account,JSON.stringify(payload),now-(options.receivedAge??0),device).run();
    return device;
  }
  return {user,now,at,add,views:()=>accountViews(env,user,[])};
}

it('history has its own device, receipt and freshness even when the selected quota comes from another device',async()=>{
  const f=await accountFixture(),quota=await f.add('Quota A',{quotaAge:1000,historyAge:3600000}),history=await f.add('History B',{quotaAge:20000,historyAge:2000,receivedAge:1500,quotaError:true,tokens:'999'});
  const [view]=await f.views();
  expect(view.deviceId).toBe(quota);expect(view.stale).toBe(false);expect(view.receivedAt).toBe(f.at(0));
  expect(view.history?.summary.lifetimeTokens).toBe('999');expect(view.historyCollectedAt).toBe(f.at(2000));
  expect(view.historyMeta).toEqual({summarySource:{deviceId:history,deviceName:'History B',collectedAt:f.at(2000),receivedAt:f.at(1500),stale:false},dailySources:[]});
});

it('three-device history union selects every day from its original snapshot and keeps exact contributing sources',async()=>{
  const f=await accountFixture();
  const a=await f.add('A',{historyAge:100000,quotaAge:1000,days:[['2026-09-01','1'],['2026-09-02','2']]}),
    b=await f.add('B',{historyAge:10000,receivedAge:1000,days:[['2026-09-03','30']],tokens:'300'}),
    c=await f.add('C',{historyAge:50000,receivedAge:2000,days:[['2026-09-01','10']]}),
    d=await f.add('D',{historyAge:120000,receivedAge:3000,days:[['2026-09-01','999']]});
  const [view]=await f.views();
  expect(view.deviceId).toBe(a);expect(view.history?.summary.lifetimeTokens).toBe('300');
  expect(view.history?.dailyUsageBuckets).toEqual([{startDate:'2026-09-01',tokens:'10'},{startDate:'2026-09-02',tokens:'2'},{startDate:'2026-09-03',tokens:'30'}]);
  expect(view.historyMeta?.summarySource.deviceId).toBe(b);
  expect(view.historyMeta?.dailySources.map(s=>({device:s.deviceId,dates:s.dates}))).toEqual([{device:b,dates:['2026-09-03']},{device:c,dates:['2026-09-01']},{device:a,dates:['2026-09-02']}]);
  expect(view.historyMeta?.dailySources.some(s=>s.deviceId===d)).toBe(false);
});

it('a recent quota upload does not make an old history observation fresh, and paused history remains labeled stale',async()=>{
  const f=await accountFixture();await f.add('Old history',{historyAge:3600000,quotaAge:1000});
  let [view]=await f.views();expect(view.stale).toBe(false);expect(view.historyMeta?.summarySource.stale).toBe(true);
  const paused=await f.add('Paused history',{historyAge:1000,paused:true});
  [view]=await f.views();expect(view.stale).toBe(false);expect(view.historyMeta?.summarySource).toMatchObject({deviceId:paused,stale:true});
});

it('an account with no history does not advertise quota metadata as history provenance',async()=>{
  const f=await accountFixture();await f.add('Quota only',{noHistory:true});const [view]=await f.views();
  expect(view.history).toBeNull();expect(view.historyCollectedAt).toBeNull();expect(view.historyMeta).toBeUndefined();
});

it('device counts retain cloud sessions across collectors separately from the latest collector report',async()=>{
  const f=await accountFixture(),device=await f.add('Reconnected collector',{noHistory:true});
  await env.DB.prepare('UPDATE devices SET protocol=3,total_threads=1,initial_complete=1 WHERE id=?').bind(device).run();
  for(const [collector,threads] of [['old',['old-1','old-2']],['current',['new-1','old-1']]] as const){
    await env.DB.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,?)').bind(f.user,collector,device,f.now).run();
    for(const thread of threads){await env.DB.prepare("INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,context_hash,context,active,complete) VALUES(?,?,?,1,'session','hash',?,1,1)").bind(f.user,collector,thread,JSON.stringify({thread_id:thread})).run();
      await env.DB.prepare('INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) VALUES(?,?,?,1,?,?)').bind(f.user,collector,thread,thread,JSON.stringify({id:thread})).run();}
  }
  const [view]=await deviceViews(env.DB,f.user);expect(view.syncedThreads).toBe(3);expect(view.retainedThreads).toBe(3);expect(view.totalThreads).toBe(1);expect(view.initialComplete).toBe(true);expect(view.sourceCounts).toEqual({known:4,complete:4,unavailable:0,pendingBatches:0});
});

it('retained session count includes unavailable sources and old active history protected by an incomplete replacement',async()=>{
  const f=await accountFixture(),device=await f.add('Interrupted replacement',{noHistory:true});
  await env.DB.prepare('UPDATE devices SET protocol=3,total_threads=1,initial_complete=1 WHERE id=?').bind(device).run();
  await env.DB.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,?)').bind(f.user,'collector',device,f.now).run();
  await env.DB.prepare("INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,context_hash,context,active,complete) VALUES(?,'collector','source',1,'session','hash',?,1,1)").bind(f.user,JSON.stringify({thread_id:'retained'})).run();
  await env.DB.prepare("INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) VALUES(?,'collector','source',1,'retained','{}')").bind(f.user).run();
  const view=async()=>(await deviceViews(env.DB,f.user))[0];expect(await view()).toMatchObject({retainedThreads:1,syncedThreads:1,initialComplete:true});
  await env.DB.prepare("UPDATE v3_sources SET available=0 WHERE user_id=? AND collector_id='collector'").bind(f.user).run();
  expect(await view()).toMatchObject({retainedThreads:1,syncedThreads:0,initialComplete:false,sourceCounts:{unavailable:1}});
  await env.DB.prepare("UPDATE v3_sources SET available=1 WHERE user_id=? AND collector_id='collector'").bind(f.user).run();
  await env.DB.prepare("INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,context_hash,context,active,complete) VALUES(?,'collector','source',2,'session','hash',?,0,0)").bind(f.user,JSON.stringify({thread_id:'replacement'})).run();
  await env.DB.prepare("INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) VALUES(?,'collector','source',2,'replacement','{}')").bind(f.user).run();
  expect(await view()).toMatchObject({retainedThreads:1,syncedThreads:0,initialComplete:false});
});
