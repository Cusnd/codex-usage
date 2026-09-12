import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/db.js';
import {Collector} from '../server/collector/store.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {Queries} from '../server/queries.js';
import {sha256} from '../server/collector/projection.js';
import {stableJson,validUploadBatch,type UploadBatch} from '../shared/sync-v3.js';

const root=await mkdtemp(path.join(os.tmpdir(),'codex-billing-fixture-'));
const sourceRoot=path.join(root,'native'),device='billing-fixture-device';
const store=new Store(':memory:'),materializer=new LocalMaterializer(store);
let phase='initial';
const captured:{phase:string;batch:UploadBatch}[]=[];
const collector=new Collector(store,{sourceRoot,identityFile:null,collectorId:'billing-fixture-collector',maxBatchRecords:2,
  origin:()=>({device_id:device,kind:'execution'}),
  onBatch:batch=>{captured.push({phase,batch:structuredClone(batch)});materializer.apply(batch);}});
try {
  await mkdir(path.join(sourceRoot,'sessions'),{recursive:true});
  const row=(type:string,payload:unknown)=>({type,timestamp:'2026-09-12T07:00:00.000Z',payload});
  const settings=(tier:string)=>row('event_msg',{type:'thread_settings_applied',thread_id:'billing-thread',thread_settings:{service_tier:tier,private:'PRIVATE_BODY_NOT_FOR_SYNC'}});
  const start=(id:string)=>[row('event_msg',{type:'task_started',turn_id:id}),row('turn_context',{turn_id:id,model:'gpt-6-astra',effort:'high'})];
  const usage=(id:string,turn:string)=>row('token_usage_record',{thread_id:'billing-thread',turn_id:turn,response_id:id,
    usage:{input_tokens:1000,cached_input_tokens:200,cache_write_input_tokens:0,output_tokens:100,reasoning_output_tokens:0,total_tokens:1100}});
  const rows=[row('session_meta',{id:'billing-thread'}),settings('default'),...start('standard-turn'),usage('billing-standard','standard-turn'),
    row('event_msg',{type:'task_complete',turn_id:'standard-turn',last_agent_message:'PRIVATE_BODY_NOT_FOR_SYNC'}),
    settings('priority'),...start('fast-turn'),usage('billing-fast','fast-turn'),settings('default'),usage('billing-unknown','fast-turn')];
  await writeFile(path.join(sourceRoot,'sessions','billing.jsonl'),rows.map(value=>JSON.stringify(value)).join('\n')+'\n');
  await collector.configureCloud(device);await collector.scan();
  const old=captured.filter(c=>c.phase==='initial').map(({batch})=>{
    const v1=structuredClone(batch);v1.extractor_version=1;
    for(const source of v1.sources){delete source.context.service_tier_state;source.context_hash=sha256(stableJson(source.context));}
    v1.records=v1.records.filter(o=>o.record?.type!=='event_msg'||o.record.payload.type==='token_count');
    for(const o of v1.records)delete o.context.service_tier_state;
    v1.records_hash=sha256(stableJson(v1.records));assert.ok(validUploadBatch(v1));return v1;
  });
  phase='upgrade';store.run('UPDATE collector_sources SET reset_required=1,version=version+1');await collector.scan();
  const upgraded=captured.filter(c=>c.phase==='upgrade').map(c=>c.batch);
  assert.ok(upgraded.length>1);assert.ok(upgraded.every(validUploadBatch));
  store.saveSettings({...store.settings(),costEnabled:true});
  const queries=new Queries(store),subscription=queries.summary();
  assert.equal(subscription.totalTokens,'3300');assert.equal(subscription.cost?.amount,'0.046200000000');
  store.saveSettings({...store.settings(),officialApiPricing:true});const api=queries.summary();
  assert.equal(api.cost?.amount,'0.039600000000');
  const fixture={device,old,upgraded,expected:{subscription,api}};
  assert.ok(!stableJson(fixture).includes('PRIVATE_BODY_NOT_FOR_SYNC'));
  await mkdir('cloud/.generated',{recursive:true});await writeFile('cloud/.generated/billing.json',JSON.stringify(fixture));
} finally {
  await collector.close();store.close();
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codex-billing-fixture-'));
  await rm(resolved,{recursive:true,force:true});
}
