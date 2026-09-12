import {SYNC_VERSION} from '../shared/cloud-version.js';
import {versionedFetch} from './fixtures/versioned-fetch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/db.js';
import {Collector} from '../server/collector/store.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {V3Uploader} from '../server/sync-v3/uploader.js';
import {CloudSync} from '../server/cloud-sync.js';
import {decodeUpload} from '../server/sync-v3/codec.js';
import {sha256} from '../server/collector/projection.js';
import type {UploadAck,UploadBatch} from '../shared/sync-v3.js';

async function setup(transport:typeof fetch, serverBuild?:()=>string|null) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'v3-uploader-')),root=path.join(dir,'codex');await mkdir(path.join(root,'sessions'),{recursive:true});
  const store=new Store(':memory:'),materializer=new LocalMaterializer(store),collector=new Collector(store,{sourceRoot:root,collectorId:'test-collector',onBatch:b=>materializer.apply(b)});await collector.configureCloud('A');
  await writeFile(path.join(root,'sessions','a.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{response_id:'r',usage:{total_tokens:3}}})+'\n');await collector.scan();
  let time=100000;const reports:{initialComplete:boolean;totalThreads:number}[]=[];
  const uploader=new V3Uploader(store,collector,{fetch:versionedFetch(async(url,options)=>{if(String(url).endsWith('/sync/status')){reports.push(JSON.parse(String(options!.body)));return Response.json({ok:true});}return transport(url,options);},serverBuild),now:()=>time,random:()=>0.5});return {store,collector,uploader,reports,advance:()=>{time+=10000;},close:async()=>{await uploader.close();await collector.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
const credentials={deviceId:'A',token:'local-test-token',origin:'https://example.test'};
function ack(batch:UploadBatch,wire:Uint8Array,status:'received'|'applied'):UploadAck {return {batch_id:batch.batch_id,wire_hash:sha256(wire),records_hash:batch.records_hash,status,received_at:'2026-09-11T12:00:00.000Z',dataset_epoch:'epoch',applied_commit_seq:status==='applied'?1:null,contiguous_received_seq:batch.lane_seq,contiguous_applied_seq:status==='applied'?batch.lane_seq:0,retry_after_ms:1,current_config_version:1};}
test('lost ACK retries exactly the persisted gzip bytes and clears only after applied',async()=>{
  const bodies:Buffer[]=[];const f=await setup(async(_url,options)=>{const wire=Buffer.from(options!.body as Uint8Array);bodies.push(wire);const batch=await decodeUpload(wire);if(bodies.length===1)throw Error('lost acknowledgement');return Response.json(ack(batch,wire,'applied'));});
  try{await f.uploader.tick(credentials);assert.equal(bodies.length,1);assert.ok(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n)>0);f.advance();await f.uploader.tick(credentials);
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n),0);assert.equal(f.uploader.status().applied.backfill,1);assert.equal(f.reports[0].initialComplete,false);assert.equal(f.reports.at(-1)!.initialComplete,true);
  }finally{await f.close();}
});

test('received retains original input, polls receipts without retransmitting, then atomically applies confirmation',async()=>{
  let saved:UploadAck|undefined,posts=0,polls=0;const f=await setup(async(url,options)=>{if(options!.method==='GET'){assert.ok(String(url).includes('/receipts?ids='));polls++;return Response.json({receipts:[{...saved!,status:'applied',applied_commit_seq:1,contiguous_applied_seq:1}]});}
    posts++;const wire=Buffer.from(options!.body as Uint8Array);saved=ack(await decodeUpload(wire),wire,'received');return Response.json(saved);});
  try{await f.uploader.tick(credentials);assert.equal(posts,1);assert.equal(f.uploader.takeNextTickDelayMs(),1000);assert.equal(f.uploader.status().received.backfill,1);assert.equal(f.uploader.status().applied.backfill,0);assert.equal(f.store.one('SELECT cloud_state FROM collector_batches')!.cloud_state,'received');
    f.advance();await f.uploader.tick(credentials);assert.equal(posts,1);assert.equal(polls,1);assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n),0);
  }finally{await f.close();}
});

test('successful bounded drains schedule one immediate continuation; empty, failed and cancelled work stays idle',async()=>{
  let succeed=true,posts=0;const f=await setup(async(_url,options)=>{
    posts++;if(!succeed)throw Error('offline');const wire=new Uint8Array(options!.body as Uint8Array);return Response.json(ack(await decodeUpload(wire),wire,'applied'));
  });
  try{
    for(let i=0;i<35;i++)f.collector.enqueueMetadata([{type:'project',source_project_id:'project-'+i,value:{name:'Project '+i}}]);
    await f.uploader.tick(credentials);assert.equal(f.uploader.takeNextTickDelayMs(),0);assert.equal(f.uploader.takeNextTickDelayMs(),1000);
    succeed=false;f.advance();await f.uploader.tick(credentials);assert.equal(f.uploader.takeNextTickDelayMs(),1000);
    succeed=true;f.advance();await f.uploader.tick(credentials);f.uploader.cancel();assert.equal(f.uploader.takeNextTickDelayMs(),1000);
    f.advance();await f.uploader.tick(credentials);assert.equal(f.uploader.status().pendingBatches,0);
    f.advance();await f.uploader.tick(credentials);assert.equal(f.uploader.takeNextTickDelayMs(),1000);assert.ok(posts>=37);
  }finally{await f.close();}
});
test('mismatched acknowledgement cannot delete pending input or advance either cursor',async()=>{
  const f=await setup(async(_url,options)=>{const wire=Buffer.from(options!.body as Uint8Array);return Response.json({...ack(await decodeUpload(wire),wire,'applied'),wire_hash:'0'.repeat(64)});});
  try{await f.uploader.tick(credentials);assert.ok(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n)>0);assert.equal(f.uploader.status().applied.backfill,0);assert.equal(f.uploader.status().received.backfill,0);}
  finally{await f.close();}
});

test('an acknowledgement for an unknown batch cannot trigger immediate retry scheduling',async()=>{
  let calls=0;const f=await setup(async(_url,options)=>{calls++;const wire=new Uint8Array(options!.body as Uint8Array);return Response.json({...ack(await decodeUpload(wire),wire,'applied'),batch_id:'unknown-batch'});});
  try{await f.uploader.tick(credentials);assert.equal(calls,1);assert.equal(f.uploader.takeNextTickDelayMs(),1000);assert.equal(f.uploader.status().pendingBatches,1);assert.equal(f.uploader.status().applied.backfill,0);}
  finally{await f.close();}
});
test('revocation blocks queued source while retaining usable local statistics',async()=>{
  let calls=0;const f=await setup(async()=>{calls++;return Response.json({error:{code:'DEVICE_REVOKED'}},{status:401});});
  try{await f.uploader.tick(credentials);f.advance();await f.uploader.tick(credentials);assert.equal(calls,1);assert.equal(f.store.one('SELECT status FROM collector_wire')!.status,'blocked');assert.equal(String(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n),'3');}
  finally{await f.close();}
});

test('a background receipt failure stops polling, preserves exact input and does not block another received lane',async()=>{
  let saved:UploadAck|undefined,posts=0,polls=0;
  const f=await setup(async(url,options)=>{
    if(options!.method==='GET'){
      polls++;const ids=new URL(String(url)).searchParams.get('ids')!;assert.ok(!ids.includes(','));
      if(ids===saved!.batch_id)return Response.json({error:{code:'BACKGROUND_APPLY_FAILED'}},{status:409});
      return Response.json({receipts:[{...saved!,batch_id:'other-lane',status:'applied',applied_commit_seq:2,contiguous_applied_seq:1}]});
    }
    posts++;const wire=Buffer.from(options!.body as Uint8Array);saved=ack(await decodeUpload(wire),wire,'received');return Response.json(saved);
  });
  try{
    await f.uploader.tick(credentials);
    const before=f.store.one('SELECT * FROM collector_wire')!;
    f.store.run("INSERT INTO collector_wire(batch_id,wire,wire_hash,records_hash,status) VALUES('other-lane',?,?,?,'received')",[before.wire,before.wire_hash,before.records_hash]);
    f.store.run("INSERT INTO collector_batches(batch_id,lane,lane_seq,source_id,generation,raw_json,local_applied,cloud_required,cloud_state,created_at) SELECT 'other-lane','live',1,'other-source',generation,raw_json,1,1,'received',created_at FROM collector_batches LIMIT 1");
    f.advance();await f.uploader.tick(credentials);
    assert.equal(posts,1);assert.equal(polls,2);
    assert.equal(f.store.one('SELECT status FROM collector_wire WHERE batch_id=?',[saved!.batch_id])!.status,'blocked');
    assert.equal(f.store.one('SELECT error FROM collector_wire WHERE batch_id=?',[saved!.batch_id])!.error,'BACKGROUND_APPLY_FAILED');
    assert.deepEqual(f.store.one('SELECT wire FROM collector_wire WHERE batch_id=?',[saved!.batch_id])!.wire,before.wire);
    assert.equal(f.store.one("SELECT batch_id FROM collector_batches WHERE batch_id='other-lane'"),undefined);
    assert.equal(f.uploader.status().applied.live,1);assert.equal(f.uploader.status().applied.backfill,0);assert.ok(f.uploader.status().error);
    assert.equal(String(f.store.one('SELECT total_tokens FROM effective_events')!.total_tokens),'3');
    f.advance();await f.uploader.tick(credentials);assert.equal(polls,2);
  }finally{await f.close();}
});

test('received transient failures respect Retry-After and retain the receipt until a later applied ACK',async()=>{
  let saved:UploadAck|undefined,polls=0;const f=await setup(async(_url,options)=>{
    if(options!.method==='GET'){polls++;return polls===1?Response.json({error:{code:'BUSY'}},{status:503,headers:{'Retry-After':'30'}}):Response.json({receipts:[{...saved!,status:'applied',applied_commit_seq:1,contiguous_applied_seq:1}]});}
    const wire=Buffer.from(options!.body as Uint8Array);saved=ack(await decodeUpload(wire),wire,'received');return Response.json(saved);
  });
  try{
    await f.uploader.tick(credentials);f.advance();await f.uploader.tick(credentials);
    assert.equal(polls,1);assert.equal(f.store.one('SELECT status FROM collector_wire')!.status,'received');
    assert.equal(Number(f.store.one('SELECT attempts FROM collector_wire')!.attempts),1);
    f.advance();await f.uploader.tick(credentials);f.advance();await f.uploader.tick(credentials);assert.equal(polls,1);
    f.advance();await f.uploader.tick(credentials);assert.equal(polls,2);assert.equal(f.uploader.status().applied.backfill,1);
  }finally{await f.close();}
});

test('disconnect after credentials are lost resets a blocked cloud binding while preserving local facts',async()=>{
  const f=await setup(async()=>Response.json({error:{code:'DEVICE_REVOKED'}},{status:401}));
  let cloud:CloudSync|undefined;
  try{
    await f.uploader.tick(credentials);assert.equal(f.store.one('SELECT status FROM collector_wire')!.status,'blocked');
    f.store.db.exec("CREATE TABLE cloud_sync(id INTEGER PRIMARY KEY,value TEXT NOT NULL)");
    f.store.run('INSERT INTO cloud_sync VALUES(1,?)',[JSON.stringify({deviceId:'A',enabled:true,fullUsage:true})]);
    cloud=new CloudSync(f.store,{credentialFile:null,observation:async()=>{throw Error('account must not be queried');},refreshLimits:async()=>{throw Error('account must not be refreshed');},origin:credentials.origin,uploader:f.uploader});
    assert.equal(cloud.status().connected,false);
    await cloud.disconnect();
    assert.equal(f.collector.binding().device_id,null);assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_wire')!.n),0);
    assert.equal(String(f.store.one('SELECT total_tokens FROM effective_events')!.total_tokens),'3');
  }finally{await cloud?.close();await f.close();}
});


test('missing or mismatched backend build preserves every pending byte and resumes only after the versions match',async()=>{
  for(const mismatch of [null,'0.1.6+older','0.1.6+newer']){
    let serverBuild:string|null=mismatch,sends=0;
    const f=await setup(async(_url,options)=>{sends++;const wire=Buffer.from(options!.body as Uint8Array);return Response.json(ack(await decodeUpload(wire),wire,'applied'));},()=>serverBuild);
    try{
      const before=f.store.all('SELECT batch_id,raw_json,cloud_state FROM collector_batches ORDER BY batch_id');
      await f.uploader.tick(credentials);assert.equal(sends,0);assert.match(f.uploader.status().error,/版本不匹配/);
      assert.deepEqual(f.store.all('SELECT batch_id,raw_json,cloud_state FROM collector_batches ORDER BY batch_id'),before);
      assert.equal(String(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n),'3');
      serverBuild=SYNC_VERSION;await f.uploader.tick(credentials);assert.equal(sends,0,'version failures retain bounded backoff');
      for(let i=0;i<7;i++)f.advance();await f.uploader.tick(credentials);
      assert.equal(sends,1);assert.equal(f.uploader.status().pendingBatches,0);assert.equal(f.uploader.status().error,null);
    }finally{await f.close();}
  }
});
