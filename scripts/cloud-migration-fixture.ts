import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../server/db.js';
import {Importer} from '../server/importer.js';
import {UsageSync} from '../server/usage-sync.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {Collector} from '../server/collector/store.js';
import {V3Uploader} from '../server/sync-v3/uploader.js';
import {decodeUpload} from '../server/sync-v3/codec.js';
import {sha256} from '../server/collector/projection.js';
import type {LegacyPreparation,UploadBatch} from '../shared/sync-v3.js';

// Regenerate actual persisted wire across a collector/uploader restart. Transport responses are
// controlled here; the resulting wires and preparation bodies are replayed into real Worker/D1 tests.
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=await mkdtemp(path.join(os.tmpdir(),'cloud-migration-wire-')),root=path.join(dir,'codex'),device=randomUUID(),thread=randomUUID(),credential={deviceId:device,token:'fixture-token',origin:'https://example.test'};
await mkdir(path.join(root,'sessions'),{recursive:true});const file=path.join(root,'sessions','weak.jsonl'),store=new Store(path.join(dir,'usage.sqlite'));
const raw=(n:number)=>JSON.stringify({type:'session_meta',payload:{id:thread}})+'\n'+JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{thread_id:thread,turn_id:'turn',usage:{input_tokens:String(n),output_tokens:'0',total_tokens:String(n)}}})+'\n';
const v2Uploads:{route:string;method:string;body:unknown}[]=[],preparations:{phase:string;body:LegacyPreparation}[]=[],uploads:{phase:string;batch:UploadBatch;wireBase64:string;wireSha256:string}[]=[];let phase='initial',now=100000,collector:Collector|undefined,uploader:V3Uploader|undefined;
try{
  await writeFile(file,raw(100));await new Importer(store,root).scan(()=>{});
  const old=new UsageSync(store,async(route,method,body)=>{v2Uploads.push({route,method,body});return {response:Response.json({}),data:route==='sync/config'?{accountKey:'a'.repeat(43),paused:false}:{}};},async()=>({identityKnown:false,identityKey:null,stableIdentity:null,data:null,collectedAt:null,attemptedAt:'2026-09-11T12:00:00Z',provider:null,errorCode:'IDENTITY_UNKNOWN',refreshInterval:300}));
  await old.tick(device,()=>true);const local=new LocalMaterializer(store);
  const transport:typeof fetch=async(url,options)=>{
    const route=new URL(String(url)).pathname;if(route==='/api/v3/sync/status')return Response.json({ok:true});
    if(route==='/api/v3/legacy/prepare'){preparations.push({phase,body:JSON.parse(String(options!.body))});return Response.json({status:'ready'});}
    assert.equal(route,'/api/v3/ingest');const wire=Buffer.from(options!.body as Uint8Array),batch=await decodeUpload(wire);uploads.push({phase,batch,wireBase64:wire.toString('base64'),wireSha256:sha256(wire)});
    if(phase==='persist-old-handoff')throw Error('lose old handoff ACK before restart');
    const handoffs=batch.metadata.filter(m=>m.type==='legacy_replacement');
    return Response.json({batch_id:batch.batch_id,wire_hash:sha256(wire),records_hash:batch.records_hash,status:'applied',received_at:'2026-09-11T12:00:00Z',dataset_epoch:'fixture-epoch',applied_commit_seq:1,contiguous_received_seq:batch.lane_seq,contiguous_applied_seq:batch.lane_seq,retry_after_ms:0,current_config_version:1,...handoffs.length?{handoff_results:handoffs.map(m=>({dataset_id:m.dataset_id,thread_id:m.thread_id,status:m.sources.some(s=>s.generation===1)&&phase==='restart-new-generation'?'superseded':'applied'}))}:{}});
  };
  collector=new Collector(store,{sourceRoot:root,stateRoot:dir,onBatch:b=>local.apply(b)});await collector.configureCloud(device);await collector.scan();uploader=new V3Uploader(store,collector,{fetch:transport,now:()=>now,random:()=>0.5});await uploader.tick(credential);
  phase='persist-old-handoff';now+=10000;await uploader.tick(credential);const immutable=store.one('SELECT wire FROM collector_wire')!.wire;assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'queued');
  await uploader.close();await collector.close();collector=new Collector(store,{sourceRoot:root,stateRoot:dir,onBatch:b=>local.apply(b)});uploader=new V3Uploader(store,collector,{fetch:transport,now:()=>now,random:()=>0.5});
  await writeFile(file,raw(105));collector.notify(file);await collector.scan({audit:true});assert.equal(Number(store.one('SELECT generation FROM collector_sources')!.generation),2);
  phase='restart-new-generation';now+=10000;await uploader.tick(credential);assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'waiting');
  const replays=uploads.filter(r=>r.batch.metadata.some(m=>m.type==='legacy_replacement'&&m.sources.some(s=>s.generation===1)));assert.equal(replays.length,2);assert.equal(replays[0].wireBase64,replays[1].wireBase64);assert.equal(replays[0].wireBase64,Buffer.from(immutable).toString('base64'));
  const live=uploads.find(r=>r.batch.sources.some(s=>s.generation===2))!;assert.equal(live.batch.lane,'live');
  phase='current-handoff';now+=10000;await uploader.tick(credential);assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'applied');
  const output={device,thread,rawBefore:raw(100),rawAfter:raw(105),v2Uploads,preparations,uploads,localFinalTotal:String(store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n)};assert.equal(output.localFinalTotal,'105');
  const destination=path.join(repository,'cloud','.generated','legacy-cross-lane.json');await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log('Generated actual migration wire: old backfill handoff replay unchanged, new live generation 2, replacement journal applied at 105.');
}finally{await uploader?.close();await collector?.close();store.close();if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))await rm(dir,{recursive:true,force:true});}
