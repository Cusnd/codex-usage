import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../modules/storage/sqlite.js';
import {Collector} from '../modules/collection/collector.js';
import {LocalMaterializer} from '../modules/collection/materializer.js';
import {V3Uploader} from '../modules/sync/upload/uploader.js';
import {encodeUpload,decodeUpload} from '../modules/sync/upload/codec.js';
import {sha256} from '../modules/collection/projection.js';
import {initialContext,normalizeTokens} from '../modules/usage/normalize.js';
import {stableJson,EXTRACTOR_VERSION,V3_CONTENT_TYPE,type UploadBatch,type UploadAck} from '../modules/contracts/sync.js';
import {SYNC_HEADER,SYNC_VERSION} from '../modules/contracts/cloud-version.js';

const output=path.resolve('artifacts/performance-current/upload');mkdirSync(output,{recursive:true});
const stamp='2026-09-12T00:00:00.000Z';
function packet(index:number,count:number):UploadBatch {
  const source='source-'+index,context={...initialContext('thread-'+index),turn_id:'turn',model:'gpt-6-astra',cwd:'/synthetic/project'};
  const records=Array.from({length:count},(_,i)=>{
    const record={type:'token_usage_record' as const,timestamp:stamp,payload:{thread_id:context.thread_id,turn_id:'turn',response_id:`response-${index}-${i}`,usage:normalizeTokens({input_tokens:'9007199254740994',output_tokens:'7',total_tokens:'9007199254741001'})}};
    return {observation_id:sha256(stableJson(['uploader-benchmark',source,1,i*100])),record_revision:1,source_id:source,generation:1,locator:i*100,byte_end:(i+1)*100,prefix_hash:sha256(stableJson(record)),session_trusted:true,origin:{kind:'execution' as const,device_id:'benchmark-device'},context,record};
  });
  return {protocol:3,schema_version:1,extractor_version:EXTRACTOR_VERSION,collector_id:'uploader-benchmark',producer_epoch:'epoch',lane:index%2?'backfill':'live',lane_seq:Math.floor(index/2)+1,batch_id:'batch-'+index,records_hash:sha256(stableJson(records)),records,metadata:[],sources:[{source_id:source,generation:1,kind:'session',from_cursor:0,to_cursor:count*100,snapshot_eof:count*100,context_hash:sha256(stableJson(context)),context,replace_start:true,replace_end:true,generation_complete:true,available:true,trailing_bytes:0}]};
}
function ack(batch:UploadBatch,wire:Uint8Array,status:'received'|'applied'):UploadAck {return {batch_id:batch.batch_id,wire_hash:sha256(wire),records_hash:batch.records_hash,status,received_at:stamp,dataset_epoch:'synthetic-server-epoch',applied_commit_seq:status==='applied'?batch.lane_seq:null,contiguous_received_seq:batch.lane_seq,contiguous_applied_seq:status==='applied'?batch.lane_seq:0,retry_after_ms:1,current_config_version:0};}
const milliseconds=(usage:NodeJS.CpuUsage)=>(usage.user+usage.system)/1000;
const codec=[];
const large=packet(0,500),raw=stableJson(large);
for(let round=0;round<6;round++){
  const cpu=process.cpuUsage(),started=performance.now(),encoded=await encodeUpload(large),wall_ms=performance.now()-started,cpu_ms=milliseconds(process.cpuUsage(cpu));
  assert.deepEqual(await decodeUpload(encoded.wire),large);
  codec.push({round,warmup:round===0,wall_ms,cpu_ms,raw_bytes:Buffer.byteLength(raw),wire_bytes:encoded.wire.byteLength,wire_hash:encoded.wire_hash,records_hash:encoded.records_hash});
}

async function drain(mode:'applied'|'lost_ack'|'received',round:number) {
  // Fresh file-backed WAL database; inputs are already locally applied, so extraction is excluded.
  const dbfile=path.join(output,`${mode}-${round}-${Date.now()}.sqlite`),store=new Store(dbfile);
  new LocalMaterializer(store);
  const collector=new Collector(store,{sourceRoot:output,collectorId:'uploader-benchmark',identityFile:null});await collector.configureCloud('benchmark-device');
  const total=mode==='applied'?50:1,packets=Array.from({length:total},(_,i)=>packet(i,100));
  store.transaction(()=>{for(const batch of packets)store.run('INSERT INTO collector_batches(batch_id,source_id,generation,lane,lane_seq,raw_json,local_applied,cloud_required,created_at) VALUES(?,?,1,?,?,?,1,1,?)',[batch.batch_id,batch.sources[0].source_id,batch.lane,batch.lane_seq,stableJson(batch),stamp]);});
  const calls={handshake:0,ingest:0,receipt:0,status:0};let transmitted=0,offset=0,failed=false;
  const wireById=new Map<string,Buffer>(),saved=new Map<string,UploadAck>(),applied=new Set<string>();
  const clock=()=>Date.now()+offset;
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),headers={[SYNC_HEADER]:SYNC_VERSION};
    const sentHeaders=new Headers(init?.headers);assert.equal(sentHeaders.get(SYNC_HEADER),SYNC_VERSION);assert.equal(sentHeaders.get('Authorization'),'Bearer synthetic-only');
    if(url.pathname.endsWith('/handshake')){calls.handshake++;return Response.json({ok:true},{headers});}
    if(url.pathname.endsWith('/sync/status')){calls.status++;return Response.json({ok:true},{headers});}
    if(url.pathname.endsWith('/receipts')){calls.receipt++;const id=url.searchParams.get('ids')!,previous=saved.get(id)!;applied.add(id);return Response.json({receipts:[{...previous,status:'applied',applied_commit_seq:1,contiguous_applied_seq:1}]},{headers});}
    assert.equal(url.pathname,'/api/v3/ingest');assert.equal(sentHeaders.get('Content-Type'),V3_CONTENT_TYPE);assert.ok(calls.handshake>0);calls.ingest++;
    const wire=Buffer.from(init!.body as Uint8Array);transmitted+=wire.length;
    const batch=await decodeUpload(wire);assert.deepEqual(batch,packets.find(b=>b.batch_id===batch.batch_id));
    const old=wireById.get(batch.batch_id);if(old)assert.deepEqual(wire,old);else wireById.set(batch.batch_id,wire);
    if(mode==='lost_ack'&&!failed){failed=true;throw Error('synthetic lost ACK');}
    const response=ack(batch,wire,mode==='received'?'received':'applied');saved.set(batch.batch_id,response);if(response.status==='applied')applied.add(batch.batch_id);
    return Response.json(response,{headers});
  };
  const uploader=new V3Uploader(store,collector,{fetch:transport,now:clock,random:()=>0.5});
  const ticks=[],cpu=process.cpuUsage(),started=performance.now();let retryState:unknown=null,receivedState:unknown=null;
  try{
    for(let i=0;i<20;i++){
      const start=performance.now(),posts=calls.ingest;await uploader.tick({deviceId:'benchmark-device',token:'synthetic-only',origin:'https://never-contacted.invalid'});
      ticks.push({wall_ms:performance.now()-start,packets:calls.ingest-posts,pending:uploader.status().pendingBatches,next_tick_ms:uploader.takeNextTickDelayMs()});
      if(i===0&&mode!=='applied'){
        const state=store.one('SELECT attempts,status,next_at,error FROM collector_wire');assert.ok(state);assert.equal(uploader.status().pendingBatches,1);
        if(mode==='lost_ack'){assert.equal(Number(state.attempts),1);assert.equal(state.status,'pending');retryState={attempts:Number(state.attempts),status:state.status,error:state.error,next_delay_ms:Number(state.next_at)-clock()};}
        else{assert.equal(state.status,'received');receivedState={status:state.status,attempts:Number(state.attempts)};}
        offset+=10000;
      }
      if(!uploader.status().pendingBatches)break;
    }
    const wall_ms=performance.now()-started,cpu_ms=milliseconds(process.cpuUsage(cpu));
    assert.equal(uploader.status().pendingBatches,0);assert.equal(applied.size,total);assert.equal(Number(store.one('SELECT COUNT(*) n FROM collector_wire')!.n),0);
    if(mode==='lost_ack')assert.equal(calls.ingest,2);if(mode==='received'){assert.equal(calls.ingest,1);assert.equal(calls.receipt,1);}
    const states=uploader.status();
    return {mode,round,warmup:round===0,total_packets:total,records_per_packet:100,wall_ms,cpu_ms,calls,transmitted_bytes:transmitted,unique_wire_bytes:[...wireById.values()].reduce((n,w)=>n+w.length,0),ticks,retryState,receivedState,applied:states.applied,received:states.received,final_pending:states.pendingBatches,exact_roundtrip:true,identical_retry_wire:mode==='lost_ack'?true:undefined};
  }finally{await uploader.close();await collector.close();store.close();}
}
const queues=[];for(let round=0;round<4;round++)queues.push(await drain('applied',round));
const recovery=[await drain('lost_ack',1),await drain('received',1)];
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary={codec_500:{median_ms:median(codec.slice(1).map(v=>v.wall_ms)),median_cpu_ms:median(codec.slice(1).map(v=>v.cpu_ms)),raw_bytes:codec[1].raw_bytes,wire_bytes:codec[1].wire_bytes},queue_50x100:{median_ms:median(queues.slice(1).map(v=>v.wall_ms)),median_cpu_ms:median(queues.slice(1).map(v=>v.cpu_ms)),ticks:queues[1].ticks.length,calls:queues[1].calls,transmitted_bytes:queues[1].transmitted_bytes},recovery:recovery.map(r=>({mode:r.mode,calls:r.calls,wall_ms:r.wall_ms,final_pending:r.final_pending,identical_retry_wire:r.identical_retry_wire}))};
const result={at:new Date().toISOString(),node:process.version,os:`${os.platform()} ${os.release()}`,cpu:os.cpus()[0]?.model,boundary:'Real uploader/codec/file-backed SQLite WAL; in-process mock transport with exact decoding and synthetic acknowledgements, no HTTP/TLS or remote D1. Retry deadline advanced by injected clock without sleeping.',summary,codec,queues,recovery};
writeFileSync(path.join(output,'current.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
