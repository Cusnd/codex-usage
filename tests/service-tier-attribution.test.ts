import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encodeUpload} from '../server/sync-v3/codec.js';
import {consumeProjected,initialContext,initialLegacyState,nextContext,projectRecord} from '../shared/usage-domain/normalize.js';
import {canonicalize} from '../shared/usage-domain/canonical.js';
import {EXTRACTOR_VERSION,stableJson,validProjectedRecord,validUploadBatch,type UploadBatch} from '../shared/sync-v3.js';
import type {Candidate,ExtractionContext,Observation} from '../shared/usage-domain/types.js';

const at='2026-09-12T07:00:00.000Z',digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const row=(type:string,payload:Record<string,unknown>)=>({type,timestamp:at,payload});
const settings=(tier:unknown,thread='thread')=>row('event_msg',{type:'thread_settings_applied',thread_id:thread,thread_settings:{service_tier:tier,model:'model',private:'NEVER-PERSIST'}});
const started=(turn:string)=>row('event_msg',{type:'task_started',turn_id:turn,private:'NEVER-PERSIST'});
const turn=(id:string)=>row('turn_context',{turn_id:id,model:'gpt-6-astra'});
const usage=(id:string,tier?:string,thread='thread')=>row('token_usage_record',{thread_id:thread,response_id:id,usage:{total_tokens:'100'},...(tier?{service_tier:tier}:{})});
const legacy=(total:string,last?:string)=>row('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},...(last?{last_token_usage:{total_tokens:last}}:{})}});
function parser(context:ExtractionContext=initialContext('thread')) {
  let state=initialLegacyState(context.thread_id),locator=0;
  return (value:ReturnType<typeof row>)=>{
    const record=projectRecord(value).record!;assert.ok(validProjectedRecord(record));context=nextContext(context,record);
    const observation:Observation={observation_id:String(++locator),record_revision:1,source_id:'source',generation:1,locator,byte_end:locator+1,prefix_hash:digest(String(locator)),session_trusted:true,origin:{device_id:'A',kind:'execution'},context,record};
    const result=consumeProjected(state,observation,{parentStatus:()=> 'complete',parentHasSignature:()=>false});state=result.state;return result.candidates[0];
  };
}
test('settings and lifecycle projection retain mode evidence without private settings or completion text',()=>{
  for(const value of [settings('priority'),settings(null),started('turn'),row('event_msg',{type:'task_complete',turn_id:'turn',last_agent_message:'NEVER-PERSIST'}),usage('record','priority')]){
    const projected=projectRecord(value).record!;assert.ok(validProjectedRecord(projected));assert.ok(!stableJson(projected).includes('NEVER-PERSIST'));
    assert.equal(validProjectedRecord({...projected,payload:{...projected.payload,secret:'private'}}),false);
  }
});
test('stable active turns use configured mode and mid-turn switches stay unknown until a new turn',()=>{
  const read=parser();read(settings('priority'));read(started('a'));read(turn('a'));
  const fast=read(usage('fast'));assert.deepEqual([fast.service_tier,fast.service_tier_source],['fast','settings']);
  read(settings('priority'));assert.equal(read(usage('same')).service_tier,'fast');
  read(settings('default'));assert.equal(read(usage('in-flight')).service_tier,'unknown');
  read(settings('priority'));read(turn('a'));assert.equal(read(usage('switched-back')).service_tier,'unknown');
  read(row('event_msg',{type:'task_complete',turn_id:'a'}));read(settings('default'));read(started('b'));read(turn('b'));
  assert.equal(read(usage('standard')).service_tier,'standard');
  read(settings(null));assert.equal(read(usage('reset')).service_tier,'unknown');
});
test('missing old markers and other thread settings never inherit a parent or sibling mode',()=>{
  const read=parser();read(started('a'));read(turn('a'));assert.equal(read(usage('old')).service_tier,'unknown');
  read(settings('priority','parent'));assert.equal(read(usage('foreign-setting')).service_tier,'unknown');
  read(row('session_meta',{id:'thread',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}));
  read(settings('priority'));read(started('b'));read(turn('b'));assert.equal(read(usage('child')).service_tier,'fast');
  assert.equal(read(usage('foreign-usage',undefined,'parent')).service_tier,'unknown');
  read(row('session_meta',{id:'other-child'}));read(started('c'));read(turn('c'));
  assert.equal(read(usage('independent',undefined,'other-child')).service_tier,'unknown');
});
test('record mode overrides configured ambiguity and unsupported record tiers stay unknown',()=>{
  const read=parser();read(settings('default'));read(started('a'));read(turn('a'));read(settings('priority'));
  assert.deepEqual([read(usage('direct','priority')).service_tier,read(usage('direct2','default')).service_tier],['fast','standard']);
  const unsupported=read(usage('unsupported','flex'));assert.deepEqual([unsupported.service_tier,unsupported.service_tier_source],['unknown','record']);
});
test('cumulative legacy intervals spanning a mode switch remain unknown while exact token differences are retained',()=>{
  const read=parser();read(settings('default'));read(started('a'));read(turn('a'));
  assert.equal(read(legacy('100')).service_tier,'unknown');
  const stable=read(legacy('150'));assert.deepEqual([stable.total_tokens,stable.service_tier],['50','standard']);
  read(row('event_msg',{type:'task_complete',turn_id:'a'}));read(settings('priority'));read(started('b'));read(turn('b'));
  const crossed=read(legacy('180'));assert.deepEqual([crossed.total_tokens,crossed.service_tier],['30','unknown']);
  assert.equal(read(legacy('200')).service_tier,'fast');
  read(legacy('190'));assert.equal(read(legacy('210')).service_tier,'unknown');
  read(settings('default'));assert.equal(read(legacy('220','20')).service_tier,'unknown');
});
test('duplicate observations enrich mode independently of canonical tokens and origin; contradictions are order independent',()=>{
  const read=parser();read(settings('priority'));read(started('a'));read(turn('a'));const known=read(usage('shared'));
  const old:Candidate={...known,observation_id:'0'};delete old.service_tier;delete old.service_tier_source;
  const selected=canonicalize([old])!;
  for(const copies of [[old,known],[known,old]]){
    const merged=canonicalize(copies)!;assert.equal(merged.service_tier,'fast');assert.equal(merged.conflict,false);assert.equal(merged.selected_observation_id,selected.selected_observation_id);
    assert.equal(merged.event_id,selected.event_id);assert.equal(merged.total_tokens,selected.total_tokens);assert.equal(merged.origin_device_id,selected.origin_device_id);
  }
  const contrary={...known,observation_id:'other',service_tier:'standard' as const};
  assert.equal(canonicalize([known,contrary])!.service_tier,'unknown');assert.equal(canonicalize([contrary,known])!.service_tier,'unknown');
  const direct={...contrary,service_tier_source:'record' as const};assert.equal(canonicalize([known,direct])!.service_tier,'standard');
  assert.equal(canonicalize([known,{...direct,service_tier:'unknown'}])!.service_tier,'unknown');
});
