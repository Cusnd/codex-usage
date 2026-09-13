import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {deviceViews} from '../../modules/accounts/worker/devices.js';
import {domain} from '../../modules/sync/publication/store.js';
import {createRead,entities,getRead,manifest} from '../../modules/sync/reads/snapshots.js';
import {actor} from './performance-fixture';

it('keeps coverage bounds separate by uploader and ignores inactive candidates',async()=>{
  const a=await actor(),b=await actor(a.user),empty=await actor(a.user),other=await actor();
  const rows=[
    {owner:a.user,device:a.device,at:'2026-09-01T00:00:00.000Z',active:1},
    {owner:a.user,device:a.device,at:'2026-09-09T00:00:00.000Z',active:1},
    {owner:a.user,device:a.device,at:'2000-01-01T00:00:00.000Z',active:0},
    {owner:a.user,device:b.device,at:'2026-09-05T00:00:00.000Z',active:1},
    {owner:a.user,device:empty.device,at:'1999-01-01T00:00:00.000Z',active:0},
    {owner:other.user,device:other.device,at:'1900-01-01T00:00:00.000Z',active:1},
  ];
  await env.DB.batch(rows.map((r,i)=>env.DB.prepare(`INSERT INTO v3_candidates(user_id,observation_id,uploader_device_id,collector_id,source_id,generation,record_revision,event_id,thread_id,at,active,candidate)
    VALUES(?,?,?,'collector','source',1,1,'event','thread',?,?,'{}')`).bind(r.owner,'observation-'+i,r.device,r.at,r.active)));
  const views=await deviceViews(env.DB,a.user);expect(views).toHaveLength(3);
  expect(views.find(v=>v.id===a.device)).toMatchObject({coverageFrom:rows[0].at,coverageTo:rows[1].at});
  expect(views.find(v=>v.id===b.device)).toMatchObject({coverageFrom:rows[3].at,coverageTo:rows[3].at});
  expect(views.find(v=>v.id===empty.device)).toMatchObject({coverageFrom:null,coverageTo:null});
  await env.DB.prepare("UPDATE v3_candidates SET active=0 WHERE user_id=? AND observation_id='observation-0'").bind(a.user).run();
  expect((await deviceViews(env.DB,a.user)).find(v=>v.id===a.device)).toMatchObject({coverageFrom:rows[1].at,coverageTo:rows[1].at});
  await env.DB.prepare("UPDATE v3_candidates SET active=1 WHERE user_id=? AND observation_id='observation-2'").bind(a.user).run();
  expect((await deviceViews(env.DB,a.user)).find(v=>v.id===a.device)).toMatchObject({coverageFrom:rows[2].at,coverageTo:rows[1].at});
});

it('projects lease metadata and frozen settings without weakening owner, expiry or deletion checks',async()=>{
  const a=await actor(),other=await actor(),read=await createRead(env.DB,a.user,'full');
  const full=await getRead(env.DB,a.user,read.lease_id),{coverage,settings,...metadata}=full;
  expect(await getRead(env.DB,a.user,read.lease_id,'metadata')).toEqual(metadata);
  expect(await getRead(env.DB,a.user,read.lease_id,'settings')).toEqual({...metadata,settings});
  expect(coverage).toBe('{"sources":[]}');expect(settings).toBeTruthy();
  await expect(getRead(env.DB,other.user,read.lease_id,'metadata')).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  await expect(getRead(env.DB,other.user,read.lease_id,'settings')).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  await env.DB.prepare('UPDATE v3_read_leases SET expires_at=0 WHERE user_id=?').bind(a.user).run();
  await expect(getRead(env.DB,a.user,read.lease_id,'metadata')).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
  const next=await createRead(env.DB,a.user,'full');
  await env.DB.prepare('UPDATE v3_sync_domains SET deletion_version=deletion_version+1 WHERE user_id=?').bind(a.user).run();
  await expect(getRead(env.DB,a.user,next.lease_id,'settings')).rejects.toMatchObject({code:'BASELINE_REQUIRED'});
});

it('counts only non-tombstone versions at the full read cut, including a clone of an old cut',async()=>{
  const a=await actor(),h=await domain(env.DB,a.user);
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(a.user),
    env.DB.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,valid_to,revision,hash,payload) VALUES
      (?,?,'event','old',1,2,1,'old','{}'),(?,?,'event','old',2,NULL,2,'new','{}'),
      (?,?,'event','deleted',1,NULL,1,'deleted',NULL),(?,?,'thread','parent',1,NULL,1,'parent','{}')`).bind(a.user,h.active_epoch,a.user,h.active_epoch,a.user,h.active_epoch,a.user,h.active_epoch),
  ]);
  const read=await createRead(env.DB,a.user,'full');expect(read.expected_entities).toEqual([{kind:'event',count:1},{kind:'thread',count:1}]);
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=2 WHERE user_id=?').bind(a.user),
    env.DB.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) VALUES(?,?,'event','later',2,1,'later','{}')`).bind(a.user,h.active_epoch),
  ]);
  const clone=await createRead(env.DB,a.user,'full',[],read.lease_id);expect(clone.cut).toEqual(read.cut);expect(clone.expected_entities).toEqual(read.expected_entities);
  expect((await createRead(env.DB,a.user,'full')).total_entities).toBe(3);
  expect((await entities(env.DB,a.user,clone.lease_id,[{kind:'event',id:'old'}])).entities[0].hash).toBe('old');
});

it('rejects a manifest after a concurrent lease deletion even when the entity statement returned a page',async()=>{
  const a=await actor(),h=await domain(env.DB,a.user);
  await env.DB.prepare("INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) VALUES(?,?,'thread','visible',0,1,'visible','{}')").bind(a.user,h.active_epoch).run();
  const read=await createRead(env.DB,a.user,'full');let deleted=false;
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
        if(key==='bind')return(...args:unknown[])=>wrap(target.bind(...args));
        if(key==='all'&&sql.includes('SELECT v.kind,v.entity_id,v.revision,v.hash FROM lease'))return async()=>{
          const result=await target.all();await env.DB.prepare('DELETE FROM v3_read_leases WHERE user_id=? AND lease_id=?').bind(a.user,read.lease_id).run();deleted=true;return result;
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});return wrap(target.prepare(sql));
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(manifest(db,a.user,read.lease_id,null)).rejects.toMatchObject({code:'BASELINE_REQUIRED'});expect(deleted).toBe(true);
});
