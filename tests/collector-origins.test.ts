import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../modules/storage/sqlite.js';
import {Collector} from '../modules/collection/collector.js';
import type { UploadBatch } from '../modules/contracts/sync.js';

test('append proofs survive rebind and restart, match the exact raw prefix, and do not claim a new binding executed old records',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'collector-origin-')),file=path.join(dir,'sessions','one.jsonl');await mkdir(path.dirname(file),{recursive:true});
  const seen:UploadBatch[]=[],database=path.join(dir,'usage.sqlite');let store=new Store(database),collector=new Collector(store,{sourceRoot:dir,stateRoot:dir,onBatch:b=>seen.push(b)});
  const metadata=JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n';
  const record=(n:number)=>JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00.000Z',payload:{response_id:'response',usage:{total_tokens:n}}})+'\n';
  const usage=()=>seen.flatMap(b=>b.records).filter(r=>r.record?.type==='token_usage_record').at(-1)!;
  try{
    await collector.configureCloud('A');await writeFile(file,metadata);await collector.scan();await appendFile(file,record(20));await collector.scan();assert.deepEqual(usage().origin,{kind:'local_append',device_id:'A'});
    await collector.configureCloud(null);await collector.close();store.close();store=new Store(database);collector=new Collector(store,{sourceRoot:dir,stateRoot:dir,onBatch:b=>seen.push(b)});
    await collector.configureCloud('A');await collector.scan();assert.deepEqual(usage().origin,{kind:'local_append',device_id:'A'});
    await collector.configureCloud('B');await collector.scan();assert.deepEqual(usage().origin,{kind:'preserved',device_id:'A'});
    await writeFile(file,metadata+record(30));await collector.scan();assert.deepEqual(usage().origin,{kind:'observed_local',device_id:'B'});
    assert.equal(Number(store.one('SELECT COUNT(*) n FROM collector_origin_proofs')!.n),1);
  }finally{await collector.close();store.close();await rm(dir,{recursive:true,force:true});}
});
