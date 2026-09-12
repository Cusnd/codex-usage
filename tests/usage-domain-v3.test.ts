import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {consumeProjected,initialContext,initialLegacyState,nextContext,projectRecord} from '../shared/usage-domain/normalize.js';
import {applyCandidateMutations,canonicalize,reconcileTurns} from '../shared/usage-domain/canonical.js';
import {applyMetricDeltas,exactTotal,type MetricRow} from '../shared/usage-domain/metrics.js';
import type {Observation,Candidate,DependencyView} from '../shared/usage-domain/types.js';
import {stableJson,validProjectedRecord} from '../shared/sync-v3.js';

const dependencies:DependencyView={parentStatus:()=> 'complete',parentHasSignature:()=>false};
function observation(id:string,amount:string,response:string|null='r'):Observation {
  return {observation_id:id,record_revision:1,source_id:'source',generation:1,locator:1,byte_end:2,prefix_hash:createHash('sha256').update(id).digest('hex'),session_trusted:true,
    origin:{device_id:'A',kind:'execution'},context:{...initialContext('thread'),turn_id:'turn'},
    record:projectRecord({type:'token_usage_record',timestamp:'2026-09-11T12:00:00Z',payload:{response_id:response,usage:{total_tokens:amount}}}).record!};
}
const candidate=(o:Observation)=>consumeProjected(initialLegacyState(o.context.thread_id),o,dependencies).candidates[0];
test('whitelist rejects nested private content and preserves exact decimals beyond int64',()=>{
  const p=projectRecord({type:'token_usage_record',timestamp:'2026-09-11',secret:'private',payload:{response_id:'x',usage:{total_tokens:'184467440737095516170',prompt:'private'},text:'private'}}).record!;
  assert.equal(validProjectedRecord(p),true);assert.ok(!stableJson(p).includes('private'));
  assert.equal(validProjectedRecord({...p,payload:{...p.payload,tool_output:'private'}}),false);
  assert.equal(candidate(observation('a','184467440737095516170')).total_tokens,'184467440737095516170');
});
test('global canonical identity precedes origin filtering and duplicate uploader does not become execution device',()=>{
  const a=candidate(observation('a','100')),copy={...candidate(observation('b','100')),origin:{device_id:'A',kind:'preserved' as const}},b={...candidate(observation('c','20','b-new')),origin:{device_id:'B',kind:'execution' as const}};
  for(const input of [[a,copy,b],[b,copy,a]]){
    const events=[canonicalize(input.filter(c=>c.event_id==='response:r'))!,canonicalize(input.filter(c=>c.event_id==='response:b-new'))!];
    const sum=(device?:string)=>events.filter(e=>!device||e.origin_device_id===device).reduce((n,e)=>n+BigInt(e.total_tokens!),0n);
    assert.deepEqual([sum(),sum('A'),sum('B')],[120n,100n,20n]);
  }
  const better={...copy,input_tokens:'100',output_tokens:'0'};assert.equal(canonicalize([a,better])!.origin_device_id,'A');
});
test('identical weak values stay independent; verified full prefix deduplicates copies only in the same session',()=>{
  const a=observation('a','10',null),b=observation('b','10',null);
  assert.notEqual(candidate(a).event_id,candidate(b).event_id);
  b.prefix_hash=a.prefix_hash;assert.equal(candidate(a).event_id,candidate(b).event_id);
  b.context={...b.context,thread_id:'other'};assert.notEqual(candidate(a).event_id,candidate(b).event_id);
  a.session_trusted=false;b.session_trusted=false;b.context=a.context;assert.notEqual(candidate(a).event_id,candidate(b).event_id);
});
test('conflicting execution origins are explicit unknown, independently of candidate arrival order',()=>{
  const a=candidate(observation('a','100')),b={...candidate(observation('b','100')),origin:{device_id:'B',kind:'execution' as const}};
  assert.equal(canonicalize([a,b])!.origin_device_id,null);assert.equal(canonicalize([b,a])!.origin_conflict,true);
});
test('observation revision migrates identity and retracts metrics exactly, retaining null semantics',()=>{
  const a=candidate(observation('a','92233720368547758070',null)),map=new Map<string,Candidate>(),metrics=new Map<string,MetricRow>();
  applyMetricDeltas(metrics,applyCandidateMutations(map,[{observation_id:'a',candidate:a}]));
  const revised={...a,event_id:'response:new',record_revision:2,response_id:'new',total_tokens:'92233720368547758071'};
  const deltas=applyCandidateMutations(map,[{observation_id:'a',candidate:revised}]);
  assert.equal(deltas.length,2);assert.equal(deltas.find(d=>d.event_id===a.event_id)!.after,null);applyMetricDeltas(metrics,deltas);
  const total=metrics.get('["all"]')!;assert.equal(total.events,1);assert.equal(exactTotal(total,'total_tokens'),'92233720368547758071');assert.equal(exactTotal(total,'input_tokens'),null);
  assert.equal(applyCandidateMutations(map,[{observation_id:'a',candidate:a}]).length,0);
  assert.throws(()=>applyCandidateMutations(map,[{observation_id:'a',candidate:{...revised,total_tokens:'1'}}]),/REVISION_CONFLICT/);
  applyMetricDeltas(metrics,applyCandidateMutations(map,[{observation_id:'a',candidate:null}]));assert.equal(total.events,0);assert.deepEqual(total.threads,{});
});
test('legacy cumulative state, duplicate limits, rollback and explicit turn replacement preserve existing meaning',()=>{
  let state=initialLegacyState('thread');const all:Candidate[]=[];
  for(const [i,total,limit] of [[1,'100','a'],[2,'100','b'],[3,'90','a'],[4,'140','a']] as const){
    const o=observation(String(i),'0',null);o.record=projectRecord({type:'event_msg',timestamp:`2026-09-11T12:00:0${i}Z`,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total}},rate_limits:{limit_id:limit}}}).record!;
    const result=consumeProjected(state,o,dependencies);state=result.state;all.push(...result.candidates);
  }
  assert.deepEqual(all.map(c=>c.total_tokens),['100','40']);assert.equal(state.high!.total_tokens,'140');assert.equal(state.issues,1);
  assert.equal(reconcileTurns([...all,candidate(observation('explicit','15'))]).length,1);
});
test('fork and subagent edges both survive; partial parent cannot declare an unmatched prefix new',()=>{
  const meta=projectRecord({type:'session_meta',timestamp:'2026-09-11T12:00:00Z',payload:{id:'child',forked_from_id:'fork',source:{subagent:{thread_spawn:{parent_thread_id:'team'}}}}}).record!;
  const o=observation('m','0');o.record=meta;o.context=nextContext(initialContext('child'),meta);
  const parsed=consumeProjected(initialLegacyState('child'),o,dependencies);assert.equal(parsed.threads[0].forked_from_id,'fork');assert.equal(parsed.threads[0].subagent_parent_id,'team');
  const usage=observation('u','0');usage.context=o.context;usage.record=projectRecord({type:'event_msg',timestamp:'2026-09-11T12:01:00Z',payload:{type:'token_count',info:{total_token_usage:{total_tokens:'10'}}}}).record!;
  const partial=consumeProjected(parsed.state,usage,{parentStatus:()=> 'partial',parentHasSignature:()=>false});assert.equal(partial.candidates[0].excluded,true);assert.equal(partial.state.deferred,true);
});
