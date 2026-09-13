import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import worker from '../../apps/cloud/index.js';
import {syncStatus} from '../../apps/cloud/routes.js';
import {deviceViews} from '../../modules/accounts/worker/devices.js';
import {domain} from '../../modules/sync/publication/store.js';
import {createRead,entities,manifest} from '../../modules/sync/reads/snapshots.js';
import {queryUsage} from '../../modules/analytics/worker/queries.js';
import {sha256,SESSION_COOKIE} from '../../modules/platform/worker/http.js';
import {stableJson} from '../../modules/contracts/sync.js';
import {actor,origin} from './performance-fixture';
import {MatchingRequest} from './matching-build';
import {instrumentD1} from './d1-performance';

it('measures authenticated device and fixed snapshot reads on 25k events and 250 sources',async({task})=>{
  const a=await actor(),h=await domain(env.DB,a.user),count=25000;
  await env.DB.batch([
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(a.user),
    env.DB.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,0)').bind(a.user,a.collector,a.device),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<249)
      INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,context_hash,context,active,complete,available)
      SELECT ?,?,'source-'||v,1,'session','fixture',json_object('thread_id','thread-'||v),1,1,1 FROM n`).bind(a.user,a.collector),
    env.DB.prepare(`INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload)
      SELECT user_id,collector_id,source_id,generation,json_extract(context,'$.thread_id'),'{}' FROM v3_sources WHERE user_id=?`).bind(a.user),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<249)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,payload)
      SELECT ?,?,'thread','thread-'||v,1,1,'fixture','thread-'||v,json_object('title','Thread '||v) FROM n`).bind(a.user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,at,origin_device_id,payload)
      SELECT ?,?,'event','event-'||printf('%06d',v),1,1,'fixture','thread-'||(v%250),'2026-09-10T12:00:00.000Z',?,
      json_object('thread_id','thread-'||(v%250),'turn_id','turn-'||v,'at','2026-09-10T12:00:00.000Z','model','gpt-5','kind','record','input_tokens','80','cached_input_tokens','20','cache_write_input_tokens','0','output_tokens','20','reasoning_output_tokens','0','total_tokens','100','incomplete',0) FROM n`).bind(count-1,a.user,h.active_epoch,a.device),
    env.DB.prepare(`INSERT INTO v3_candidates(user_id,observation_id,uploader_device_id,collector_id,source_id,generation,record_revision,event_id,thread_id,turn_id,at,active,candidate)
      SELECT user_id,entity_id,?,?, 'source-'||(rowid%250),1,1,entity_id,thread_id,entity_id,at,1,json_object('event',json(payload),'evidence',printf('%02000d',0)) FROM v3_entity_versions WHERE user_id=? AND kind='event'`).bind(a.device,a.collector,a.user),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<2499)
      INSERT INTO v3_receipts(user_id,batch_id,device_id,collector_id,producer_epoch,lane,lane_seq,wire_hash,records_hash,status,received_at,applied_at)
      SELECT ?,'batch-'||v,?,?,'epoch','live',v,'fixture','fixture',CASE WHEN v%25=0 THEN 'received' ELSE 'applied' END,v,CASE WHEN v%25=0 THEN NULL ELSE v END FROM n`).bind(a.user,a.device,a.collector),
  ]);
  const expected=await deviceViews(env.DB,a.user),lease=await createRead(env.DB,a.user,'full'),page=await manifest(env.DB,a.user,lease.lease_id,null,200);
  expect(expected[0].sourceCounts).toEqual({known:250,complete:250,unavailable:0,pendingBatches:100});
  expect(expected[0]).toMatchObject({syncedThreads:250,retainedThreads:250,coverageFrom:'2026-09-10T12:00:00.000Z',coverageTo:'2026-09-10T12:00:00.000Z'});
  const samples:Record<string,unknown>[]=[];
  async function measure(name:string,round:number,run:(db:D1Database)=>Promise<unknown>){
    const measured=instrumentD1(env.DB),started=performance.now(),result=await run(measured.db),elapsed_ms=performance.now()-started;
    // Lease identities/expiry are generated per request, so compare stable response content.
    const ids=new Map([[a.user,'user'],[a.device,'device'],[a.collector,'collector'],[h.active_epoch,'epoch']]);
    const normalized=JSON.parse(JSON.stringify(result,(key,value)=>['lease_id','expires_at','boundAt','updated_at'].includes(key)?undefined:typeof value==='string'?(ids.get(value)??value):value));
    samples.push({name,round,warmup:round===0,elapsed_ms,...measured.stats,result_hash:await sha256(stableJson(normalized)),trace:round===1?measured.trace:undefined});
    return result;
  }
  for(let round=0;round<6;round++){
    const view=await measure('devices-http',round,async db=>{
      const response=await worker.fetch(new MatchingRequest(origin+'/api/v3/devices',{headers:{Cookie:SESSION_COOKIE+'='+a.session}}),{...env,DB:db});
      expect(response.status).toBe(200);return response.json();
    });expect(view).toEqual({devices:expected});
    const status=await measure('sync-status',round,db=>syncStatus(db,a.user)) as any;expect(status.devices).toEqual(expected);
    const read=await measure('create-full',round,db=>createRead(db,a.user,'full')) as any;expect(read.total_entities).toBe(count+250);
    const selected=await measure('manifest-200',round,db=>manifest(db,a.user,lease.lease_id,null,200)) as any;expect(selected.entities).toEqual(page.entities);
    const loaded=await measure('entities-200',round,db=>entities(db,a.user,lease.lease_id,page.entities)) as any;expect(loaded.entities).toHaveLength(200);
    const summary=await measure('summary',round,db=>queryUsage(db,a.user,new URL(origin+'/?lease_id='+lease.lease_id),'local/summary')) as any;
    expect(summary.data).toMatchObject({eventCount:count,totalTokens:String(count*100),threadCount:250});
  }
  (task.meta as Record<string,unknown>).readPerformance={count,sources:250,receipts:2500,samples};
},60000);
