import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/db.js';
import {Importer} from '../server/importer.js';
import {Collector} from '../server/collector/store.js';
import {LocalMaterializer} from '../server/local-materializer.js';
import {legacyPreparations,queueLegacyReplacements} from '../server/sync-v3/migration.js';
import {validUploadBatch} from '../shared/sync-v3.js';
import {normalizeSourcePath} from '../shared/usage-domain/paths.js';
import {projectPath} from '../server/util.js';

test('legacy handoff requires every original source to be complete and applied under its original binding',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v3-handoff-')),store=new Store(':memory:');let collector:Collector|undefined;
  try{
    const root=path.join(dir,'codex');await mkdir(path.join(root,'sessions'),{recursive:true});
    for(const id of ['a','b'])await writeFile(path.join(root,'sessions',id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{response_id:id,usage:{total_tokens:3}}})+'\n');
    await new Importer(store,root).scan(()=>{});
    store.db.exec('CREATE TABLE usage_sync_state(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE usage_sync_outbox(id TEXT PRIMARY KEY,payload TEXT)');
    store.run('INSERT INTO usage_sync_state VALUES(1,?)',[JSON.stringify({deviceId:'A',datasetId:'v2-data'})]);store.run("INSERT INTO usage_sync_outbox VALUES('thread',NULL)");
    const local=new LocalMaterializer(store);assert.equal(JSON.parse(store.one('SELECT source_files FROM collector_legacy_replacements')!.source_files).length,2);
    collector=new Collector(store,{sourceRoot:root,collectorId:'collector',onBatch:b=>local.apply(b)});await collector.configureCloud('A');await collector.scan();
    const preparation=legacyPreparations(store,'collector','A');assert.equal(preparation.length,1);assert.equal(preparation[0].replacements[0].sources.length,2);assert.equal(preparation[0].replacements[0].dataset_id,'v2-data');assert.deepEqual(legacyPreparations(store,'collector','B'),[]);
    assert.equal(store.one('SELECT COUNT(*) n FROM effective_events')!.n,2n);assert.equal(store.one("SELECT COUNT(*) n FROM usage_events WHERE file<>'v3:canonical'")!.n,0n);
    const queue=(device='A')=>queueLegacyReplacements(store,'collector',device,collector!.binding().producer_epoch);
    queue();assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'waiting');
    store.run("UPDATE collector_batches SET cloud_state='applied'");store.run('UPDATE collector_sources SET available=0 WHERE id=(SELECT id FROM collector_sources LIMIT 1)');queue();assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'waiting');assert.equal(legacyPreparations(store,'collector','A')[0].replacements[0].sources.length,2);
    store.run('UPDATE collector_sources SET available=1');queue('B');assert.equal(store.one('SELECT status FROM collector_legacy_replacements')!.status,'waiting');
    queue();queue();const saved=store.all("SELECT raw_json FROM collector_batches WHERE source_id='legacy:thread'");assert.equal(saved.length,1);const batch=JSON.parse(saved[0].raw_json);assert.ok(validUploadBatch(batch));assert.deepEqual(batch.sources,[]);const replacement=batch.metadata[0];assert.ok(replacement.type==='legacy_replacement');assert.equal(replacement.sources.length,2);assert.equal(replacement.dataset_id,'v2-data');
    store.run("DELETE FROM collector_batches WHERE source_id='legacy:thread'");queue();assert.equal(store.all("SELECT raw_json FROM collector_batches WHERE source_id='legacy:thread'").length,1);
  }finally{await collector?.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('source path normalization preserves POSIX case and matches source-platform Windows paths',()=>{
  for(const value of ['/Repo/A/../B/','/','repo/../nested','../../repo','C:\\Repo\\A\\..\\B\\','C:\\','C:relative\\..\\next','\\\\server\\Share\\A\\..\\B','\\\\?\\C:\\Repo\\A','\\\\?\\UNC\\Server\\Share\\Repo','//server/share/Repo'])assert.equal(normalizeSourcePath(value),projectPath(value),value);
  assert.notEqual(normalizeSourcePath('/Repo'),normalizeSourcePath('/repo'));
});
