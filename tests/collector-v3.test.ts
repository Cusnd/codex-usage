import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/db.js';
import {Collector} from '../server/collector/store.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {StreamingImporter} from '../server/collector/importer.js';
import {DatabaseSync} from 'node:sqlite';
import {validUploadBatch,type UploadBatch} from '../shared/sync-v3.js';

const line=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:'2026-09-11T12:00:00Z',payload})+'\n';
const record=(id:string,n:number)=>line('token_usage_record',{response_id:id,usage:{total_tokens:n}});
async function setup(consumer=true) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'collector-v3-')),root=path.join(dir,'codex'),state=path.join(dir,'state');await mkdir(path.join(root,'sessions'),{recursive:true});await mkdir(path.join(root,'archived_sessions'));
  const store=new Store(path.join(state,'usage.sqlite')),materializer=new LocalMaterializer(store),seen:UploadBatch[]=[];
  const collector=new Collector(store,{sourceRoot:root,stateRoot:state,chunkBytes:17,checkpointBytes:512,maxPassBytes:1024,maxBatchRecords:2,onBatch:consumer?batch=>{materializer.apply(batch);seen.push(batch);}:undefined});
  const file=path.join(root,'sessions','session.jsonl');return {dir,root,state,store,collector,file,seen,close:async()=>{await collector.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('one extraction stream is privacy-filtered, bounded, exact, incrementally materialized and unbound does not retain upload history',async()=>{
  const f=await setup();try{
    const content=line('session_meta',{id:'thread',cwd:'/repo'})+line('response_item',{secret:'NEVER-PERSIST'})+record('a',100)+record('b',20)+'{"type":';await writeFile(f.file,content);
    const m=await f.collector.scan();assert.deepEqual(m.errors,[]);assert.equal(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n,120n);
    assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n),0);assert.ok(f.seen.every(validUploadBatch));assert.ok(!JSON.stringify(f.seen).includes('NEVER-PERSIST'));
    assert.equal(Number(f.store.one('SELECT offset FROM collector_sources')!.offset),Buffer.byteLength(content)-8);
    const next=await f.collector.scan();assert.equal(next.bytes_read,0);
    await appendFile(f.file,'"ignored"}\n'+record('c',3));await f.collector.scan();assert.equal(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n,123n);
  }finally{await f.close();}
});
test('unacknowledged extraction survives consumer crash and restart without advancing twice',async()=>{
  const f=await setup(false);try{
    await writeFile(f.file,line('session_meta',{id:'thread'})+record('a',7));await f.collector.scan();assert.ok(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n)>0);
    await f.collector.close();const materializer=new LocalMaterializer(f.store),collector=new Collector(f.store,{sourceRoot:f.root,stateRoot:f.state,onBatch:batch=>materializer.apply(batch)});
    await collector.scan();assert.equal(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n,7n);assert.equal(Number(f.store.one('SELECT COUNT(*) n FROM collector_batches')!.n),0);await collector.close();
  }finally{await f.close();}
});
test('generation replacement keeps old complete data visible until final checkpoint and archive rename retains identity',async()=>{
  const f=await setup();try{
    await writeFile(f.file,line('session_meta',{id:'thread',cwd:'/old'})+record('a',100));await f.collector.scan();const id=f.store.one('SELECT id FROM collector_sources')!.id;
    const moved=path.join(f.root,'archived_sessions','session.jsonl');await rename(f.file,moved);await f.collector.scan();assert.equal(f.store.one('SELECT id FROM collector_sources WHERE path=?',[moved])!.id,id);
    const observed:number[]=[],projects:string[]=[];const replacement=new Collector(f.store,{sourceRoot:f.root,stateRoot:f.state,maxBatchRecords:1,onBatch:batch=>{new LocalMaterializer(f.store).apply(batch);observed.push(Number(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n));projects.push(f.store.one('SELECT project FROM threads WHERE id=?',['thread'])!.project);}});
    await writeFile(moved,line('session_meta',{id:'thread',cwd:'/new'})+record('b',40)+record('c',10));await replacement.scan();assert.ok(observed.slice(0,-1).every(n=>n===100));assert.equal(observed.at(-1),50);assert.ok(projects.slice(0,-1).every(p=>p==='/old'));assert.equal(projects.at(-1),'/new');await replacement.close();
  }finally{await f.close();}
});
test('missing and restored source availability is transmitted without deleting complete history',async()=>{
  const f=await setup();try{
    await f.collector.configureCloud('A');await writeFile(f.file,line('session_meta',{id:'thread'})+record('a',10));await f.collector.scan();
    const outside=path.join(f.dir,'temporarily-unavailable.jsonl');await rename(f.file,outside);await f.collector.scan();
    let last=f.seen.at(-1)!;assert.equal(last.sources[0].available,false);assert.equal(last.sources[0].generation_complete,true);assert.equal(last.records.length,0);
    assert.equal(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n,10n);
    await rename(outside,f.file);await f.collector.scan();last=f.seen.at(-1)!;assert.equal(last.sources[0].available,true);assert.equal(last.records.length,0);assert.ok(f.seen.every(validUploadBatch));
  }finally{await f.close();}
});
test('cloud bind rebuilds durable baseline, final bytes are immutable and complete chain detects same-prefix copies',async()=>{
  const f=await setup();try{
    await writeFile(f.file,line('session_meta',{id:'thread'})+record('a',10));await f.collector.scan();await f.collector.configureCloud('A');await f.collector.scan();
    const batches=f.store.all('SELECT raw_json FROM collector_batches');assert.ok(batches.length>0);assert.ok(batches.every(r=>validUploadBatch(JSON.parse(r.raw_json))));
    const original=await readFile(f.file);await writeFile(path.join(f.root,'sessions','copy.jsonl'),original);await f.collector.scan();assert.equal(f.store.one('SELECT SUM(total_tokens) n FROM effective_events')!.n,10n);
  }finally{await f.close();}
});
test('App project rename emits metadata without a new usage record or source reread',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v3-project-refresh-')),root=path.join(dir,'codex'),projectRoot=path.join(dir,'repo');await mkdir(path.join(root,'sessions'),{recursive:true});await mkdir(projectRoot);
  const appDb=new DatabaseSync(path.join(root,'state_5.sqlite'));appDb.exec('CREATE TABLE projects(id TEXT,name TEXT);CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);CREATE TABLE threads(id TEXT,project_id TEXT)');
  appDb.prepare('INSERT INTO projects VALUES(?,?)').run('p','Before');appDb.prepare('INSERT INTO project_roots VALUES(?,0,?)').run('p',projectRoot);appDb.prepare('INSERT INTO threads VALUES(?,?)').run('thread','p');
  const store=new Store(':memory:'),importer=new StreamingImporter(store,root);try{
    const file=path.join(root,'sessions','one.jsonl'),body=line('session_meta',{id:'thread',cwd:projectRoot})+record('one',3);await writeFile(file,body);await importer.collector.configureCloud('A');await importer.scan();
    store.run('DELETE FROM collector_batches WHERE local_applied=1');appDb.prepare('UPDATE projects SET name=? WHERE id=?').run('After','p');await importer.scan();
    const batches=store.all('SELECT raw_json FROM collector_batches').map(r=>JSON.parse(r.raw_json) as UploadBatch);assert.ok(batches.length);assert.ok(batches.every(b=>b.records.length===0&&validUploadBatch(b)));assert.ok(batches.flatMap(b=>b.metadata).some(m=>m.type==='project'&&m.value.name==='After'));
    assert.equal(store.one('SELECT total_tokens FROM effective_events')!.total_tokens,'3');assert.equal(await readFile(file,'utf8'),body);assert.equal(Number(store.one('SELECT generation FROM collector_sources')!.generation),1);
  }finally{await importer.close();store.close();appDb.close();await rm(dir,{recursive:true,force:true});}
});
