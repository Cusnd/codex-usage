import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import worker from '../../apps/cloud/index.js';
import {SESSION_COOKIE} from '../../modules/platform/worker/http.js';
import {SYNC_HEADER,SYNC_VERSION} from '../../modules/contracts/cloud-version.js';
import type {PageRead} from '../../modules/contracts/read-lease.js';
import {stableJson} from '../../modules/contracts/sync.js';
import {domain} from '../../modules/sync/publication/store.js';
import {createPageRead,getRead,renewPageRead} from '../../modules/sync/reads/snapshots.js';
import {defaultSettings} from '../../modules/settings/defaults.js';
import {instrumentD1} from './d1-performance';
import {actor,call,origin} from './performance-fixture';

async function seed(){
  const a=await actor(),b=await actor(a.user),h=await domain(env.DB,a.user);
  const payload=(device:string,total:string)=>stableJson({event_id:'event',thread_id:'thread',turn_id:'turn',response_id:'response',at:'2026-09-12T12:00:00.000Z',source_project_id:'project',model:'gpt-5',effort:'high',kind:'record',origin_device_id:device,input_tokens:total,cached_input_tokens:'0',cache_write_input_tokens:'0',output_tokens:'0',reasoning_output_tokens:'0',total_tokens:total,incomplete:0});
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(a.user),
    env.DB.prepare('INSERT INTO v3_settings(user_id,revision,payload) VALUES(?,1,?)').bind(a.user,stableJson({...defaultSettings,timezone:'UTC'})),
    env.DB.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,valid_to,revision,hash,at,thread_id,origin_device_id,payload) VALUES
      (?,?,'event','a',1,2,1,'old','2026-09-12T12:00:00.000Z','thread',?,?),
      (?,?,'event','a',2,NULL,2,'new','2026-09-12T12:00:00.000Z','thread',?,?),
      (?,?,'event','b',1,NULL,1,'b','2026-09-12T12:00:00.000Z','thread',?,?)`)
      .bind(a.user,h.active_epoch,a.device,payload(a.device,'9007199254741001'),a.user,h.active_epoch,a.device,payload(a.device,'42'),a.user,h.active_epoch,b.device,payload(b.device,'11')),
  ]);
  return {a,b,h};
}

it('creates online page metadata without entity counts or source coverage enumeration',async()=>{
  const {a,h}=await seed(),measured=instrumentD1(env.DB),page=await createPageRead(measured.db,a.user);
  expect(Object.keys(page).sort()).toEqual(['cut','expires_at','lease_id','settings','user_id']);
  expect(page).toMatchObject({user_id:a.user,cut:{dataset_epoch:h.active_epoch,commit_seq:1},settings:{timezone:'UTC'}});
  expect(Date.parse(page.expires_at)-Date.now()).toBeGreaterThan(14*60000);
  expect(measured.stats.statements).toBe(3);
  expect(measured.trace.map(row=>row.sql).join('\n')).not.toMatch(/v3_(entity_versions|sources|collectors|candidates)|COUNT\(/);
  expect(await getRead(env.DB,a.user,page.lease_id)).toMatchObject({coverage:'{}',scope:'full',from_at:null,device_ids:'[]'});
  const response=await call(a,'/api/v3/view','POST',{});expect(response.status).toBe(201);expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json<PageRead>()).toMatchObject({user_id:a.user,settings:{timezone:'UTC'}});
});

it('keeps device scope, exact query results, cut and settings fixed across head changes and rebuilds',async()=>{
  const {a,b,h}=await seed(),page=await createPageRead(env.DB,a.user,[a.device]),all=await createPageRead(env.DB,a.user);
  const summary=async(read:PageRead,extra='')=>{
    const response=await call(a,'/api/v3/usage/local/summary?lease_id='+read.lease_id+extra);
    expect(response.status).toBe(200);return response.json<{data:{totalTokens:string};meta:{cut:PageRead['cut'];timezone:string}}>();
  };
  expect((await summary(page,'&deviceIds='+b.device)).data.totalTokens).toBe('9007199254741001');
  expect((await summary(all)).data.totalTokens).toBe('9007199254741012');
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=2,config_version=config_version+1 WHERE user_id=?').bind(a.user),
    env.DB.prepare('UPDATE v3_settings SET payload=? WHERE user_id=?').bind(stableJson({...defaultSettings,timezone:'Asia/Shanghai'}),a.user),
  ]);
  const renewed=await renewPageRead(env.DB,a.user,page.lease_id);
  expect(renewed.cut).toEqual(page.cut);expect(renewed.settings).toEqual(page.settings);expect(renewed.lease_id).toBe(page.lease_id);
  expect(await summary(page)).toMatchObject({data:{totalTokens:'9007199254741001'},meta:{cut:page.cut,timezone:'UTC'}});
  const latest=await createPageRead(env.DB,a.user,[a.device]);expect(latest.cut.commit_seq).toBe(2);expect(latest.settings.timezone).toBe('Asia/Shanghai');expect((await summary(latest)).data.totalTokens).toBe('42');
  await env.DB.prepare("UPDATE v3_sync_domains SET mode='rebuilding' WHERE user_id=?").bind(a.user).run();
  await expect(createPageRead(env.DB,a.user)).rejects.toMatchObject({code:'DATASET_UPDATING'});
  expect((await renewPageRead(env.DB,a.user,page.lease_id)).cut).toEqual(page.cut);expect((await summary(page)).data.totalTokens).toBe('9007199254741001');
  await env.DB.prepare("UPDATE v3_sync_domains SET mode='ready',active_epoch=? WHERE user_id=?").bind('new-'+h.active_epoch,a.user).run();
  expect((await renewPageRead(env.DB,a.user,page.lease_id)).cut).toEqual(page.cut);expect((await summary(page)).data.totalTokens).toBe('9007199254741001');
});

it('validates requested devices and never switches the scope on renewal',async()=>{
  const a=await actor(),b=await actor(a.user),other=await actor();
  for(const body of [null,[],{scope:'full'},{device_ids:'bad'},{device_ids:[null]},{device_ids:[a.device,a.device]},{device_ids:Array.from({length:101},(_,i)=>'d'+i)}]){
    expect((await call(a,'/api/v3/view','POST',body)).status,JSON.stringify(body)).toBe(400);
  }
  for(const device of [other.device,'missing'])expect((await call(a,'/api/v3/view','POST',{device_ids:[device]})).status).toBe(404);
  // Revocation retains historical data, so a selected retained device remains readable.
  await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=?').bind(Date.now(),a.device).run();
  const response=await call(a,'/api/v3/view','POST',{device_ids:[a.device]});expect(response.status).toBe(201);const page=await response.json<PageRead>();
  expect((await call(a,'/api/v3/view/'+page.lease_id+'/renew','POST',{device_ids:[b.device]})).status).toBe(400);
  const renewed=await call(a,'/api/v3/view/'+page.lease_id+'/renew','POST');expect(renewed.status).toBe(200);
  const emptyStream=new Request(origin+'/api/v3/view/'+page.lease_id+'/renew',{method:'POST',headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+a.session,[SYNC_HEADER]:SYNC_VERSION},body:new Uint8Array(0)});
  expect(emptyStream.body).not.toBeNull();expect((await worker.fetch(emptyStream,env)).status).toBe(200);
  expect((await getRead(env.DB,a.user,page.lease_id,'metadata')).device_ids).toBe(stableJson([a.device]));
});

it('requires session, matching protocol and same-origin POST for create and renew',async()=>{
  const a=await actor(),page=await createPageRead(env.DB,a.user),paths=['/api/v3/view','/api/v3/view/'+page.lease_id+'/renew'];
  for(const path of paths){
    const request=(headers:Record<string,string>,method='POST')=>worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',[SYNC_HEADER]:SYNC_VERSION,Cookie:SESSION_COOKIE+'='+a.session,...headers},...(method==='POST'?{body:'{}'}:{})}),env);
    expect((await request({Cookie:''})).status).toBe(401);
    expect((await request({[SYNC_HEADER]:'0.0.0'})).status).toBe(426);
    expect((await request({Origin:'https://another.example'})).status).toBe(403);
    expect((await request({},'GET')).status).toBe(405);
  }
  await env.DB.prepare('UPDATE device_sync_versions SET sync_version=? WHERE device_id=?').bind('0.0.0',a.device).run();
  for(const path of paths)expect((await call(a,path,'POST',{})).status).toBe(426);
});

it('rejects another user, expiration and hard deadline without resurrecting leases',async()=>{
  const a=await actor(),other=await actor(),page=await createPageRead(env.DB,a.user),now=Date.now();
  expect((await call(other,'/api/v3/view/'+page.lease_id+'/renew','POST')).status).toBe(409);
  expect((await call(other,'/api/v3/usage/local/summary?lease_id='+page.lease_id)).status).toBe(409);
  const deadline=now+120000;
  await env.DB.prepare('UPDATE v3_read_leases SET expires_at=?,max_expires_at=? WHERE user_id=? AND lease_id=?').bind(now+60000,deadline,a.user,page.lease_id).run();
  expect((await renewPageRead(env.DB,a.user,page.lease_id)).expires_at).toBe(new Date(deadline).toISOString());
  await env.DB.prepare('UPDATE v3_read_leases SET max_expires_at=0 WHERE user_id=? AND lease_id=?').bind(a.user,page.lease_id).run();
  await expect(renewPageRead(env.DB,a.user,page.lease_id)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  const expired=await createPageRead(env.DB,a.user);
  await env.DB.prepare('UPDATE v3_read_leases SET expires_at=0 WHERE user_id=? AND lease_id=?').bind(a.user,expired.lease_id).run();
  await expect(renewPageRead(env.DB,a.user,expired.lease_id)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  expect(await env.DB.prepare('SELECT expires_at FROM v3_read_leases WHERE user_id=? AND lease_id=?').bind(a.user,expired.lease_id).first('expires_at')).toBe(0);
});

it('rejects deletion in progress, changed deletion versions and deletion between mutation and return',async()=>{
  const a=await actor(),page=await createPageRead(env.DB,a.user);
  await env.DB.prepare("UPDATE v3_sync_domains SET mode='deleting' WHERE user_id=?").bind(a.user).run();
  await expect(createPageRead(env.DB,a.user)).rejects.toMatchObject({code:'HISTORY_UPDATING'});
  await expect(renewPageRead(env.DB,a.user,page.lease_id)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  await env.DB.prepare("UPDATE v3_sync_domains SET mode='ready',deletion_version=deletion_version+1 WHERE user_id=?").bind(a.user).run();
  await expect(renewPageRead(env.DB,a.user,page.lease_id)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  for(const operation of ['create','renew'] as const){
    const target=await createPageRead(env.DB,a.user);let changed=false;
    const db=new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
          if(key==='bind')return(...args:unknown[])=>wrap(target.bind(...args));
          if(key==='run'&&sql.startsWith(operation==='create'?'INSERT INTO v3_read_leases':'UPDATE v3_read_leases SET expires_at'))return async()=>{
            const result=await target.run();await env.DB.prepare('UPDATE v3_sync_domains SET deletion_version=deletion_version+1 WHERE user_id=?').bind(a.user).run();changed=true;return result;
          };
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }});return wrap(target.prepare(sql));
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(operation==='create'?createPageRead(db,a.user):renewPageRead(db,a.user,target.lease_id)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});expect(changed).toBe(true);
  }
});
