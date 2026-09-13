import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {Store} from '../modules/storage/sqlite.js';
import {StreamingImporter} from '../modules/collection/importer.js';
import {discoverSources} from '../modules/collection/discovery.js';
import type {CollectionMetrics} from '../modules/collection/types.js';

// Each invocation creates fresh durable databases. Existing input files are read only.
// Use the same --source path for before/after, or the deterministic synthetic default.
const arg=(name:string,fallback:string)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:fallback;
const output=path.resolve(arg('--output','artifacts/performance-current/collection'));
const label=arg('--label','baseline'),rounds=Number(arg('--rounds','3')),events=Number(arg('--events','10000'));
assert.match(label,/^[a-zA-Z0-9-]+$/,'use a simple artifact label');
assert.ok(Number.isSafeInteger(rounds)&&rounds>0&&Number.isSafeInteger(events)&&events>0);
mkdirSync(output,{recursive:true});
const source=path.resolve(arg('--source',path.join(output,'synthetic-source')));
const synthetic=!process.argv.includes('--source');
const line=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:'2026-09-12T12:00:00.000Z',payload})+'\n';
const token=(thread:string,index:number)=>line('token_usage_record',{thread_id:thread,turn_id:`turn-${index}`,response_id:`response-${index}`,usage:{input_tokens:'1000',cached_input_tokens:'600',cache_write_input_tokens:'0',output_tokens:'100',reasoning_output_tokens:'50',total_tokens:'1100'}});
if(synthetic){
  mkdirSync(path.join(source,'sessions'),{recursive:true});mkdirSync(path.join(source,'archived_sessions'),{recursive:true});
  for(let file=0;file<100;file++){
    const thread=`perf-thread-${file}`,rows=[line('session_meta',{id:thread,cwd:'/performance/fixed'}),line('turn_context',{model:'gpt-5',effort:'high'})];
    for(let i=file;i<events;i+=100)rows.push(line('response_item',{text:'ignored '.repeat(128)}),token(thread,i));
    writeFileSync(path.join(source,'sessions',`source-${file}.jsonl`),rows.join(''));
  }
}
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
const manifest=async()=>Promise.all((await discoverSources(source)).sort((a,b)=>a.file.localeCompare(b.file)).map(({file})=>{const bytes=readFileSync(file);return {file:path.relative(source,file),bytes:bytes.length,sha256:hash(bytes)};}));
const input=await manifest(),runs:unknown[]=[];
for(let round=0;round<rounds;round++){
  const state=path.join(output,`${label}-${round}-${Date.now()}`);mkdirSync(state,{recursive:true});
  writeFileSync(path.join(state,'collector-identity.json'),json({version:1,collector_id:'performance-fixed-collector'}));
  const store=new Store(path.join(state,'usage.sqlite'));let metrics:CollectionMetrics|undefined;
  const importer=new StreamingImporter(store,source,{stateRoot:state,onCycle:(_progress,m)=>{metrics=m;}});
  try{
    const delay=monitorEventLoopDelay({resolution:10});delay.enable();
    const cpu=process.cpuUsage(),start=performance.now();await importer.scan();const coldMs=performance.now()-start,used=process.cpuUsage(cpu);delay.disable();
    assert.deepEqual(metrics!.errors,[]);const coldMetrics={...metrics!};
    const digest=()=>hash(json({events:store.all('SELECT * FROM effective_events ORDER BY event_key'),threads:store.all('SELECT * FROM threads ORDER BY id')}));
    const resultHash=digest(),unchanged=[];
    for(let i=0;i<3;i++){const t=performance.now();await importer.scan();unchanged.push({ms:performance.now()-t,metrics:{...metrics!}});assert.equal(metrics!.bytes_read,0);assert.equal(digest(),resultHash);}
    const incremental=[];
    if(synthetic){
      // Only this benchmark-owned synthetic source is appended, then restored for the next round.
      const file=path.join(source,'sessions','source-0.jsonl'),original=readFileSync(file);
      try{for(let i=0;i<5;i++){const row=token('perf-thread-0',events+i),t=performance.now();appendFileSync(file,row);importer.collector.notify(file);const m=await importer.collector.drain();incremental.push({ms:performance.now()-t,metrics:m});assert.deepEqual(m.errors,[]);assert.equal(m.selected_records,1);}}
      finally{writeFileSync(file,original);}
    }
    assert.equal(store.one('PRAGMA integrity_check')!.integrity_check,'ok');
    assert.equal(store.one('SELECT COUNT(*) n FROM collector_sources WHERE offset>size OR caught_up<>1 OR reset_required<>0')!.n,0n);
    const eventsCount=Number(store.one('SELECT COUNT(*) n FROM effective_events')!.n),threadsCount=Number(store.one('SELECT COUNT(*) n FROM threads')!.n);
    if(synthetic)assert.equal(eventsCount,events+5);
    const row={round,cold_ms:coldMs,cpu_ms:(used.user+used.system)/1000,event_loop_max_ms:Number(delay.max)/1e6,peak_rss_bytes:process.resourceUsage().maxRSS*1024,cold_metrics:coldMetrics,result_sha256:resultHash,events:eventsCount,threads:threadsCount,unchanged,incremental};runs.push(row);
    console.log(json({label,round,cold_ms:coldMs,unchanged_ms:unchanged.map(v=>v.ms),incremental_ms:incremental.map(v=>v.ms),result_sha256:resultHash}));
  }finally{await importer.close();store.close();}
}
assert.deepEqual(await manifest(),input,'all source bytes remain unchanged');
const result={label,created_at:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model,platform:process.platform,scope:'StreamingImporter.scan through durable local materialization and status mirror; source generation, store/importer construction, output hashing, upload and UI excluded. OS cache not flushed. maxRSS is process cumulative high-water, not a per-round memory peak.',source,synthetic,input_files:input.length,input_bytes:input.reduce((n,r)=>n+r.bytes,0),input_sha256:hash(json(input)),runs};
writeFileSync(path.join(output,`${label}.json`),JSON.stringify(result,null,2)+'\n');
if(process.argv.includes('--compare')){
  const before=JSON.parse(readFileSync(path.resolve(arg('--compare','')),'utf8'));
  assert.equal(result.input_sha256,before.input_sha256,'identical source manifest');
  assert.equal(result.input_bytes,before.input_bytes);
  const hashes=new Set([...before.runs,...runs].map((row:any)=>row.result_sha256));
  assert.equal(hashes.size,1,'complete effective event and thread rows are identical');
  console.log('PASS: fixed input and full effective event/thread output hashes match the reference.');
}
