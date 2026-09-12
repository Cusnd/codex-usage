import test from 'node:test';
import assert from 'node:assert/strict';
import {groupLegacyPreparations} from '../server/sync-v3/migration.js';
import {stableJson,type LegacyPreparation,validUploadBatch} from '../shared/sync-v3.js';

const preparation=(thread:number,sources=1,wide=false):LegacyPreparation=>({collector_id:'collector',replacements:[{type:'legacy_replacement',dataset_id:'legacy',thread_id:(wide?'界'.repeat(1000):'thread-')+thread,sources:Array.from({length:sources},(_,i)=>({source_id:'source-'+thread+'-'+i,generation:1}))}]});
function verify(input:LegacyPreparation[]){
  const groups=groupLegacyPreparations(input);
  assert.deepEqual(groups.flatMap(g=>g.body.replacements),input.flatMap(p=>p.replacements));
  assert.deepEqual(groups.flatMap(g=>g.keys),input.map(stableJson));
  for(const {body} of groups){
    assert.ok(Buffer.byteLength(JSON.stringify(body))<=65536);
    assert.ok(body.replacements.reduce((n,m)=>n+m.sources.length,0)<=500);
    assert.ok(validUploadBatch({protocol:3,schema_version:1,extractor_version:1,collector_id:body.collector_id,producer_epoch:'prepare',lane:'backfill',lane_seq:1,batch_id:'prepare',records_hash:'0'.repeat(64),sources:[],records:[],metadata:body.replacements}));
  }
  return groups;
}
test('200 migration registrations become four bounded requests without dropping readiness keys or source generations',()=>{
  const input=Array.from({length:200},(_,i)=>preparation(i));assert.equal(verify(input).length,4);
  const updated=structuredClone(input);updated[0].replacements[0].sources[0].generation=2;
  assert.notEqual(groupLegacyPreparations(updated)[0].keys[0],groupLegacyPreparations(input)[0].keys[0]);
});
test('registration packing observes UTF-8 bytes and total source count as independent limits',()=>{
  assert.ok(verify(Array.from({length:80},(_,i)=>preparation(i,1,true))).length>2);
  assert.equal(verify(Array.from({length:8},(_,i)=>preparation(i,100))).length,2);
  assert.deepEqual(groupLegacyPreparations([]),[]);
});
