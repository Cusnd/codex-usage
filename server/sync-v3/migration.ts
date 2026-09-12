import {randomUUID} from 'node:crypto';
import type {Store} from '../db.js';
import {stableJson,type SyncMetadata,type UploadBatch,type LegacyPreparation} from '../../shared/sync-v3.js';
import {sha256} from '../collector/projection.js';

function schema(store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS collector_legacy_replacements(device_id TEXT NOT NULL,dataset_id TEXT NOT NULL,thread_id TEXT NOT NULL,source_files TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',batch_id TEXT,PRIMARY KEY(device_id,dataset_id,thread_id));`);}
/** Capture the provenance map before the new local view removes any old file facts. */
export function captureLegacyReplacementMap(store:Store){
  schema(store);
  if(!store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_sync_state'")||!store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_sync_outbox'"))return;
  const saved=store.one('SELECT value FROM usage_sync_state WHERE id=1');if(!saved)return;
  const state=JSON.parse(saved.value);if(typeof state.deviceId!=='string'||typeof state.datasetId!=='string')return;
  for(const thread of store.all('SELECT id FROM usage_sync_outbox')){
    if(store.one('SELECT 1 FROM collector_legacy_replacements WHERE device_id=? AND dataset_id=? AND thread_id=?',[state.deviceId,state.datasetId,thread.id]))continue;
    const files=store.all(`SELECT DISTINCT s.path,s.identity FROM source_files s WHERE s.path IN (SELECT file FROM usage_events WHERE thread_id=? AND file<>'v3:canonical') OR json_extract(s.state,'$.thread')=?`,[thread.id,thread.id]);
    if(files.length)store.run('INSERT INTO collector_legacy_replacements(device_id,dataset_id,thread_id,source_files) VALUES(?,?,?,?)',[state.deviceId,state.datasetId,thread.id,stableJson(files)]);
  }
}
/** Register exact retained provenance before any immutable pending wire is replayed. */
export function legacyPreparations(store:Store,collectorId:string,deviceId:string):LegacyPreparation[] {
  schema(store);const requests:LegacyPreparation[]=[];
  for(const row of store.all("SELECT * FROM collector_legacy_replacements WHERE device_id=? AND status<>'applied'",[deviceId])){
    const sources=new Map<string,{source_id:string;generation:number}>();
    for(const file of JSON.parse(row.source_files) as {path:string;identity:string}[]){
      const source=store.one('SELECT id,generation FROM collector_sources WHERE path=? OR identity=? ORDER BY CASE WHEN path=? THEN 0 ELSE 1 END LIMIT 1',[file.path,file.identity,file.path]);
      if(!source)continue;
      sources.set(stableJson([source.id,Number(source.generation)]),{source_id:source.id,generation:Number(source.generation)});
      // A restart can leave an older immutable packet in flight while a newer generation exists.
      // Collector source batches each contain exactly one source, and their
      // immutable source/generation headers are saved in the same transaction as
      // raw_json. Read those indexed headers rather than reparsing every pending
      // usage payload before every HTTP request. Metadata/handoff batches have
      // different source IDs and cannot appear in this source's pending rows.
      for(const pending of store.all("SELECT DISTINCT generation FROM collector_batches WHERE source_id=? AND cloud_required=1 AND cloud_state<>'applied'",[source.id])){
        const generation=Number(pending.generation);
        sources.set(stableJson([source.id,generation]),{source_id:source.id,generation});
      }
    }
    // Preparation is additive, so generation groups can be registered separately without retiring history.
    const generations=new Map<number,{source_id:string;generation:number}[]>();for(const s of sources.values()){const list=generations.get(s.generation)||[];list.push(s);generations.set(s.generation,list);}
    for(const values of generations.values())for(let i=0;i<values.length;i+=100)requests.push({collector_id:collectorId,replacements:[{type:'legacy_replacement',dataset_id:row.dataset_id,thread_id:row.thread_id,sources:values.slice(i,i+100)}]});
  }
  return requests;
}
/** Pack additive registrations within the existing HTTP and source-count limits. */
export function groupLegacyPreparations(preparations:LegacyPreparation[]):{body:LegacyPreparation;keys:string[]}[] {
  const groups:{body:LegacyPreparation;keys:string[]}[]=[];
  let group:typeof groups[number]|undefined,sourceCount=0,bytes=0;
  for(const preparation of preparations){
    const count=preparation.replacements.reduce((sum,m)=>sum+m.sources.length,0);
    const added=preparation.replacements.reduce((sum,m)=>sum+Buffer.byteLength(JSON.stringify(m))+1,0);
    if(!group||group.body.collector_id!==preparation.collector_id||group.body.replacements.length+preparation.replacements.length>64||sourceCount+count>500||bytes+added>48*1024){
      group={body:{collector_id:preparation.collector_id,replacements:[]},keys:[]};groups.push(group);sourceCount=0;bytes=Buffer.byteLength(JSON.stringify(group.body));
    }
    group.body.replacements.push(...preparation.replacements);group.keys.push(stableJson(preparation));sourceCount+=count;bytes+=added;
    if(bytes>64*1024)throw Object.assign(Error('legacy preparation exceeds request limit'),{code:'LEGACY_PREPARATION_TOO_LARGE'});
  }
  return groups;
}
/** Queue a handoff only after every old source is complete and applied under the same device. */
export function queueLegacyReplacements(store:Store,collectorId:string,deviceId:string,producerEpoch:string){
  schema(store);
  store.run("UPDATE collector_legacy_replacements SET status='waiting',batch_id=NULL WHERE device_id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM collector_batches b WHERE b.batch_id=collector_legacy_replacements.batch_id)",[deviceId]);
  for(const row of store.all("SELECT * FROM collector_legacy_replacements WHERE device_id=? AND status='waiting' LIMIT 100",[deviceId])){
    const files=JSON.parse(row.source_files) as {path:string;identity:string}[],sources:{source_id:string;generation:number}[]=[];
    for(const file of files){
      const source=store.one('SELECT * FROM collector_sources WHERE path=? OR identity=? ORDER BY CASE WHEN path=? THEN 0 ELSE 1 END LIMIT 1',[file.path,file.identity,file.path]);
      if(!source||!source.available||!source.complete||source.reset_required||store.one("SELECT 1 FROM collector_batches WHERE source_id=? AND cloud_required=1 AND cloud_state<>'applied' LIMIT 1",[source.id]))break;
      sources.push({source_id:source.id,generation:Number(source.generation)});
    }
    if(sources.length!==files.length||!sources.length||sources.length>500)continue;
    const metadata:SyncMetadata={type:'legacy_replacement',dataset_id:row.dataset_id,thread_id:row.thread_id,sources:[...new Map(sources.map(s=>[s.source_id,s])).values()]};
    store.transaction(()=>{
      const laneSeq=Number(store.one("SELECT next_seq FROM collector_lane_sequences WHERE lane='backfill'")!.next_seq);
      const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:1,collector_id:collectorId,producer_epoch:producerEpoch,lane:'backfill',lane_seq:laneSeq,batch_id:randomUUID(),records_hash:sha256(stableJson([])),sources:[],records:[],metadata:[metadata]};
      store.run("INSERT INTO collector_batches(batch_id,source_id,generation,lane,lane_seq,raw_json,local_applied,cloud_required,created_at) VALUES(?,?,1,'backfill',?,?,1,1,?)",[batch.batch_id,'legacy:'+row.thread_id,laneSeq,stableJson(batch),new Date().toISOString()]);
      store.run("UPDATE collector_lane_sequences SET next_seq=next_seq+1 WHERE lane='backfill'");
      store.run("UPDATE collector_legacy_replacements SET status='queued',batch_id=? WHERE device_id=? AND dataset_id=? AND thread_id=?",[batch.batch_id,deviceId,row.dataset_id,row.thread_id]);
    });
  }
}
