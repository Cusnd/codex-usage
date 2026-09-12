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
import {legacyPreparations} from '../server/sync-v3/migration.js';
import type {UploadAck,UploadBatch} from '../shared/sync-v3.js';

async function setup(transport:typeof fetch) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'v3-uploader-')),root=path.join(dir,'codex');await mkdir(path.join(root,'sessions'),{recursive:true});
  const store=new Store(':memory:'),materializer=new LocalMaterializer(store),collector=new Collector(store,{sourceRoot:root,collectorId:'test-collector',onBatch:b=>materializer.apply(b)});await collector.configureCloud('A');
  await writeFile(path.join(root,'sessions','a.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{response_id:'r',usage:{total_tokens:3}}})+'\n');await collector.scan();
  let time=100000;const reports:{initialComplete:boolean;totalThreads:number}[]=[];
  const uploader=new V3Uploader(store,collector,{fetch:async(url,options)=>{if(String(url).endsWith('/sync/status')){reports.push(JSON.parse(String(options!.body)));return Response.json({ok:true});}return transport(url,options);},now:()=>time,random:()=>0.5});return {store,collector,uploader,reports,advance:()=>{time+=10000;},close:async()=>{await uploader.close();await collector.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
const credentials={deviceId:'A',token:'local-test-token',origin:'https://example.test'};
function ack(batch:UploadBatch,wire:Uint8Array,status:'received'|'applied'):UploadAck {return {batch_id:batch.batch_id,wire_hash:sha256(wire),records_hash:batch.records_hash,status,received_at:'2026-09-11T12:00:00.000Z',dataset_epoch:'epoch',applied_commit_seq:status==='applied'?1:null,contiguous_received_seq:batch.lane_seq,contiguous_applied_seq:status==='applied'?batch.lane_seq:0,retry_after_ms:1,current_config_version:1};}
test('lost ACK retries exactly the persisted gzip bytes and clears only after applied',async()=>{
  const bodies:Buffer[]=[];const f=await setup(async(_url,options)=>{const wire=Buffer.from(options!.body as Uint8Array);bodies.push(wire);const batch=await decodeUpload(wire);if(bodies.length===1)throw Error('lost acknowledgement');return Response.json(ack(batch,wire,'applied'));});
  try{await f.uploader.tick(credentials);assert.equal(bodies.length,1);assert.ok(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n)>0);f.advance();await f.uploader.tick(credentials);
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n),0);assert.equal(f.uploader.status().applied.backfill,1);assert.equal(f.reports[0].initialComplete,false);assert.equal(f.reports.at(-1)!.initialComplete,true);
  }finally{await f.close();}
});

test('migration preparation precedes old pending wire replay and received ACK polling without rewriting bytes',async()=>{
  for(const initial of ['pending','received'] as const){
    const requests:string[]=[],bodies:Buffer[]=[];let prepared=false,first=true,saved:UploadAck|undefined;
    const f=await setup(async(url,options)=>{
      const route=new URL(String(url)).pathname;requests.push(route);
      if(route==='/api/v3/legacy/prepare')return Response.json({status:prepared?'ready':'pending'},{status:prepared?200:202});
      if(options!.method==='GET')return Response.json({receipts:[{...saved!,status:'applied',applied_commit_seq:1,contiguous_applied_seq:1}]});
      const wire=Buffer.from(options!.body as Uint8Array);bodies.push(wire);const batch=await decodeUpload(wire);saved=ack(batch,wire,initial==='received'&&first?'received':'applied');
      if(first){first=false;if(initial==='pending')throw Error('old-client lost ACK');}return Response.json(saved);
    });
    try{
      await f.uploader.tick(credentials);const original=f.store.one('SELECT wire FROM collector_wire')!.wire;
      const source=f.store.one('SELECT path,identity FROM collector_sources')!;
      f.store.run("INSERT INTO collector_legacy_replacements(device_id,dataset_id,thread_id,source_files) VALUES('A','v2-data','thread',?)",[JSON.stringify([source])]);
      f.store.run('UPDATE collector_sources SET generation=generation+1');
      assert.deepEqual(legacyPreparations(f.store,f.collector.id,'A').flatMap(p=>p.replacements.flatMap(r=>r.sources.map(s=>s.generation))).sort(),[1,2]);
      f.store.run('UPDATE collector_sources SET generation=generation-1');
      f.advance();requests.length=0;await f.uploader.tick(credentials);assert.deepEqual(requests,['/api/v3/legacy/prepare']);assert.deepEqual(f.store.one('SELECT wire FROM collector_wire')!.wire,original);
      prepared=true;f.advance();requests.length=0;await f.uploader.tick(credentials);assert.equal(requests[0],'/api/v3/legacy/prepare');
      assert.ok(requests.includes(initial==='pending'?'/api/v3/ingest':'/api/v3/receipts'));if(initial==='pending')assert.deepEqual(bodies[0],bodies[1]);
      assert.equal(f.uploader.status().applied.backfill>=1,true);
    }finally{await f.close();}
  }
});

test('a scan that advances generation during preparation cannot upload its new wire before that generation is ready',async()=>{
  const ready=new Set<number>(),sent:UploadBatch[]=[],bodies:Buffer[]=[];let changed=false,allowSecond=false;
  const f=await setup(async(url,options)=>{
    if(new URL(String(url)).pathname==='/api/v3/legacy/prepare'){
      const generations=(JSON.parse(String(options!.body)).replacements as {sources:{generation:number}[]}[]).flatMap(m=>m.sources.map(s=>s.generation));
      if(generations.includes(2)&&!allowSecond)return Response.json({status:'pending'},{status:202});
      for(const generation of generations)ready.add(generation);
      if(!changed){changed=true;const file=f.store.one('SELECT path FROM collector_sources')!.path;await writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{response_id:'r',usage:{total_tokens:5}}})+'\n');f.collector.notify(file);await f.collector.scan({audit:true});assert.equal(Number(f.store.one('SELECT generation FROM collector_sources')!.generation),2);}
      return Response.json({status:'ready'});
    }
    const wire=Buffer.from(options!.body as Uint8Array),batch=await decodeUpload(wire);for(const source of batch.sources)assert.ok(ready.has(source.generation),'wire escaped preparation for generation '+source.generation);sent.push(batch);bodies.push(wire);return Response.json(ack(batch,wire,'applied'));
  });
  try{
    const source=f.store.one('SELECT path,identity FROM collector_sources')!;f.store.run("INSERT INTO collector_legacy_replacements(device_id,dataset_id,thread_id,source_files) VALUES('A','v2-data','thread',?)",[JSON.stringify([source])]);
    await f.uploader.tick(credentials);assert.equal(sent.length,0);assert.ok(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n)>=2);const preserved=Buffer.from(f.store.one('SELECT wire FROM collector_wire')!.wire);
    allowSecond=true;for(let i=0;i<4;i++){f.advance();await f.uploader.tick(credentials);}
    assert.deepEqual(bodies[0],preserved);assert.deepEqual([...new Set(sent.flatMap(b=>b.sources.map(s=>s.generation)))].sort(),[1,2]);assert.equal(String(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n),'5');assert.equal(f.store.one('SELECT status FROM collector_legacy_replacements')!.status,'applied');
  }finally{await f.close();}
});

test('grouped preparation preserves every source and retries pending or lost responses before uploading',async()=>{
  const preparations:{collector_id:string;replacements:{sources:{source_id:string;generation:number}[]}[]}[]=[],uploaded:Uint8Array[]=[];
  let phase:'pending'|'lost'|'ready'='pending';
  const f=await setup(async(url,options)=>{
    if(new URL(String(url)).pathname==='/api/v3/legacy/prepare'){
      const body=JSON.parse(String(options!.body));preparations.push(body);
      assert.ok(Buffer.byteLength(String(options!.body))<=65536);
      if(phase==='pending'&&preparations.length===2)return Response.json({status:'pending'},{status:202});
      if(phase==='lost')throw Error('registration acknowledgement lost');
      return Response.json({status:'ready'});
    }
    const wire=new Uint8Array(options!.body as Uint8Array);uploaded.push(wire);
    return Response.json(ack(await decodeUpload(wire),wire,'received'));
  });
  try{
    for(let i=1;i<200;i++)await writeFile(path.join(f.collector.sourceRoot,'sessions',`extra-${i}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:'thread-'+i}})+'\n');
    await f.collector.scan();
    for(const source of f.store.all('SELECT id,path,identity,state FROM collector_sources'))f.store.run("INSERT INTO collector_legacy_replacements(device_id,dataset_id,thread_id,source_files) VALUES('A','v2-data',?,?)",[JSON.parse(source.state).context.thread_id,JSON.stringify([{path:source.path,identity:source.identity}])]);
    const expected=legacyPreparations(f.store,f.collector.id,'A');assert.equal(expected.length,200);
    const queue=f.store.all('SELECT batch_id,raw_json FROM collector_batches ORDER BY seq');
    await f.uploader.tick(credentials);assert.equal(preparations.length,2);assert.equal(uploaded.length,0);
    assert.deepEqual(f.store.all('SELECT batch_id,raw_json FROM collector_batches ORDER BY seq'),queue);
    preparations.length=0;phase='lost';f.advance();await f.uploader.tick(credentials);assert.equal(preparations.length,1);assert.equal(uploaded.length,0);
    preparations.length=0;phase='ready';f.advance();await f.uploader.tick(credentials);assert.equal(preparations.length,4);assert.equal(uploaded.length,1);
    assert.deepEqual(preparations.flatMap(p=>p.replacements),expected.flatMap(p=>p.replacements));
    assert.deepEqual(f.store.all('SELECT batch_id,raw_json FROM collector_batches ORDER BY seq'),queue);
  }finally{await f.close();}
});

test('an explicit superseded handoff receipt requeues migration even when the local generation still equals the old wire',async()=>{
  let supersede=true;const handoffs:UploadBatch[]=[];const f=await setup(async(_url,options)=>{
    if(typeof options!.body==='string')return Response.json({status:'ready'});
    const wire=Buffer.from(options!.body as Uint8Array),batch=await decodeUpload(wire),metadata=batch.metadata.filter(m=>m.type==='legacy_replacement');if(metadata.length)handoffs.push(batch);
    return Response.json({...ack(batch,wire,'applied'),...metadata.length?{handoff_results:metadata.map(m=>({dataset_id:m.dataset_id,thread_id:m.thread_id,status:supersede?'superseded':'applied'}))}:{}});
  });
  try{
    await f.uploader.tick(credentials);const source=f.store.one('SELECT path,identity FROM collector_sources')!;f.store.run("INSERT INTO collector_legacy_replacements(device_id,dataset_id,thread_id,source_files) VALUES('A','v2-data','thread',?)",[JSON.stringify([source])]);
    f.advance();await f.uploader.tick(credentials);assert.equal(Number(f.store.one('SELECT generation FROM collector_sources')!.generation),1);assert.equal(f.store.one('SELECT status FROM collector_legacy_replacements')!.status,'waiting');assert.equal(f.store.one('SELECT batch_id FROM collector_legacy_replacements')!.batch_id,null);assert.equal(f.store.one("SELECT COUNT(*) n FROM collector_wire WHERE status='blocked'")!.n,0n);
    f.store.run('UPDATE collector_sources SET generation=2');supersede=false;f.advance();await f.uploader.tick(credentials);assert.equal(f.store.one('SELECT status FROM collector_legacy_replacements')!.status,'applied');assert.equal(handoffs[1].metadata.find(m=>m.type==='legacy_replacement')!.sources[0].generation,2);assert.equal(handoffs[1].lane_seq,handoffs[0].lane_seq+1);
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
