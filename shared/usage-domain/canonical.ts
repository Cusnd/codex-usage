import { stableJson } from '../sync-v3.js';
import { TOKEN_FIELDS, type Candidate, type CanonicalEvent, type EventDelta, type ServiceTier, type ServiceTierSource } from './types.js';

/** Explicit records replace the compatibility count for their complete turn, including partial explicit coverage. */
export function reconcileTurns(candidates: Candidate[]): Candidate[] {
  const turns=new Set(candidates.filter(c=>c.kind==='record'&&!c.excluded&&c.turn_id!==null).map(c=>stableJson([c.thread_id,c.turn_id])));
  return candidates.filter(c=>!c.excluded&&(c.kind==='record'||c.turn_id===null||!turns.has(stableJson([c.thread_id,c.turn_id]))));
}
const evidenceRank={execution:4,preserved:3,local_append:2,observed_local:1,unknown:0};
function score(c:Candidate):number[] {
  return [Number(!c.incomplete),c.identity_quality==='response'?2:c.identity_quality==='verified_prefix'?1:0,
    TOKEN_FIELDS.reduce((n,k)=>n+Number(c[k]!==null),0),[c.model,c.effort,c.source_project_id,c.turn_id].filter(v=>v!==null).length];
}
function compare(a:Candidate,b:Candidate) {
  const x=score(a),y=score(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return y[i]-x[i];
  return a.observation_id<b.observation_id?-1:a.observation_id>b.observation_id?1:0;
}
export function canonicalize(candidates: Candidate[]): CanonicalEvent|null {
  const eligible=reconcileTurns(candidates);if(!eligible.length)return null;
  const chosen=[...eligible].sort(compare)[0];
  if(eligible.some(c=>c.event_id!==chosen.event_id))throw Error('canonicalize requires one event identity');
  let best=0;const origins=new Set<string>();
  for(const c of eligible)if(c.origin.device_id){const rank=evidenceRank[c.origin.kind];if(rank>best){best=rank;origins.clear();}if(rank===best&&rank>0)origins.add(c.origin.device_id);}
  // Mode evidence can enrich an older copy without changing token selection or origin.
  const tierRank={record:2,settings:1,unknown:0};let bestTier=0;const tiers=new Set<ServiceTier>();
  for(const c of eligible)if(c.service_tier){
    const rank=tierRank[c.service_tier_source??'unknown'];if(rank>bestTier){bestTier=rank;tiers.clear();}if(rank===bestTier&&rank>0)tiers.add(c.service_tier);
  }
  const service_tier:ServiceTier=tiers.size===1?[...tiers][0]:'unknown',service_tier_source:ServiceTierSource=service_tier==='unknown'?'unknown':bestTier===2?'record':'settings';
  const value=(c:Candidate)=>stableJson([c.thread_id,c.turn_id,c.at,...TOKEN_FIELDS.map(k=>c[k])]);
  return {...Object.fromEntries(TOKEN_FIELDS.map(k=>[k,chosen[k]])) as Pick<Candidate,typeof TOKEN_FIELDS[number]>,
    event_id:chosen.event_id,thread_id:chosen.thread_id,turn_id:chosen.turn_id,response_id:chosen.response_id,at:chosen.at,
    project:chosen.project,source_project_id:chosen.source_project_id,model:chosen.model,effort:chosen.effort,kind:chosen.kind,
    origin_device_id:origins.size===1?[...origins][0]:null,incomplete:chosen.incomplete,identity_quality:chosen.identity_quality,
    conflict:eligible.some(c=>value(c)!==value(chosen)),origin_conflict:origins.size>1,selected_observation_id:chosen.observation_id,service_tier,service_tier_source};
}
/** Mutates an owned candidate map. Identity changes withdraw the old event before choosing both identities. */
export function applyCandidateMutations(current:Map<string,Candidate>,mutations:({observation_id:string;candidate:Candidate|null})[]):EventDelta[] {
  const affected=new Set<string>(),before=new Map<string,CanonicalEvent|null>();
  const remember=(id:string)=>{if(!affected.has(id)){affected.add(id);before.set(id,canonicalize([...current.values()].filter(c=>c.event_id===id)));}};
  for(const {observation_id,candidate} of mutations) {
    const old=current.get(observation_id);if(candidate&&candidate.observation_id!==observation_id)throw Error('observation identity mismatch');
    if(old&&candidate){if(candidate.record_revision<old.record_revision)continue;if(candidate.record_revision===old.record_revision){if(stableJson(candidate)!==stableJson(old))throw Error('REVISION_CONFLICT');continue;}}
    if(old)remember(old.event_id);if(candidate)remember(candidate.event_id);
    if(candidate)current.set(observation_id,candidate);else current.delete(observation_id);
  }
  return [...affected].sort().map(event_id=>({event_id,before:before.get(event_id)!,after:canonicalize([...current.values()].filter(c=>c.event_id===event_id))}));
}
