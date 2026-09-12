import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../server/db.js';
import {Collector} from '../server/collector/store.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {encodeUpload} from '../server/sync-v3/codec.js';
import type {UploadBatch} from '../shared/sync-v3.js';

// Both cloud tests and local tests use output produced by the default Collector.
// No origin override or hand-authored preserved claim is used here.
const dir=await mkdtemp(path.join(os.tmpdir(),'codex-origin-regression-'));
const devices={A:'origin-device-A',B:'origin-device-B',C:'origin-device-C',D:'origin-device-D',E:'origin-device-E',F:'origin-device-F'};
const thread='origin-thread',response='origin-response',at='2026-09-11T12:00:00.000Z';
const line=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:at,payload})+'\n';
const metadata=line('session_meta',{id:thread})+line('turn_context',{turn_id:'turn'});
const record=(n:number)=>line('token_usage_record',{thread_id:thread,turn_id:'turn',response_id:response,usage:{input_tokens:n,output_tokens:0,total_tokens:n}});
const batches:{phase:string;batch:UploadBatch;wireBase64:string}[]=[];
const resources:{store:Store;collector:Collector}[]=[];
async function fixture(name:keyof typeof devices){
  const root=path.join(dir,name);await mkdir(path.join(root,'sessions'),{recursive:true});
  const store=new Store(path.join(root,'usage.sqlite')),materializer=new LocalMaterializer(store);
  const collector=new Collector(store,{sourceRoot:root,stateRoot:root,collectorId:'origin-collector-'+name,onBatch:b=>materializer.apply(b)});
  await collector.configureCloud(devices[name]);resources.push({store,collector});return {root,store,collector,file:path.join(root,'sessions','session.jsonl')};
}
async function capture(f:Awaited<ReturnType<typeof fixture>>,phase:string){
  assert.deepEqual((await f.collector.scan()).errors,[]);
  for(const row of f.store.all('SELECT raw_json FROM collector_batches ORDER BY seq')){const batch=JSON.parse(row.raw_json) as UploadBatch;const encoded=await encodeUpload(batch);batches.push({phase,batch,wireBase64:encoded.wire.toString('base64')});}
  f.store.run('DELETE FROM collector_batches WHERE local_applied=1');
}
try{
  const a=await fixture('A');await writeFile(a.file,metadata);await capture(a,'initial-A');await appendFile(a.file,record(20));await capture(a,'append-A');
  const raw=await readFile(a.file),b=await fixture('B');await writeFile(b.file,raw);await capture(b,'copy-B');
  const copyHash=createHash('sha256').update(await readFile(b.file)).digest('hex');assert.equal(createHash('sha256').update(raw).digest('hex'),copyHash);
  await a.collector.configureCloud(null);await a.collector.close();a.store.close();
  const store=new Store(path.join(a.root,'usage.sqlite')),materializer=new LocalMaterializer(store),collector=new Collector(store,{sourceRoot:a.root,stateRoot:a.root,onBatch:batch=>materializer.apply(batch)});
  a.store=store;a.collector=collector;resources[0]={store,collector};await collector.configureCloud(devices.A);await capture(a,'rebind-A');
  await writeFile(a.file,metadata+record(30));await capture(a,'corrected-A');
  await b.collector.configureCloud(null);await b.collector.configureCloud(devices.B);await capture(b,'rebind-B');
  const c=await fixture('C');await writeFile(c.file,raw);await capture(c,'fresh-copy-C');
  const d=await fixture('D');await writeFile(d.file,metadata);await capture(d,'initial-D');await appendFile(d.file,record(20));await capture(d,'append-D');
  const extra=Array.from({length:501},(_,i)=>line('token_usage_record',{thread_id:thread,turn_id:'turn',response_id:'origin-extra-'+i,usage:{input_tokens:1,output_tokens:0,total_tokens:1}})).join('');
  const e=await fixture('E');await writeFile(e.file,metadata);await capture(e,'initial-E');await appendFile(e.file,record(20)+extra);await capture(e,'append-E');
  const f=await fixture('F');await writeFile(f.file,await readFile(e.file));await capture(f,'copy-F');await writeFile(e.file,metadata+record(30)+extra);await capture(e,'corrected-E');
  const usage=(phase:string)=>batches.filter(b=>b.phase===phase).flatMap(b=>b.batch.records).find(r=>r.record?.type==='token_usage_record')!;
  assert.equal(usage('append-A').origin.kind,'local_append');assert.equal(usage('copy-B').origin.kind,'observed_local');assert.equal(usage('rebind-A').origin.kind,'local_append');assert.equal(usage('corrected-A').origin.kind,'observed_local');
  await mkdir('cloud/.generated',{recursive:true});await writeFile('cloud/.generated/collector-origins.json',JSON.stringify({devices,thread,response,copyHash,batches}));
  console.log('Collector origin fixture: append/rebind/copy/correction generated and verified');
}finally{for(const r of resources){await r.collector.close();r.store.close();}await rm(dir,{recursive:true,force:true});}
