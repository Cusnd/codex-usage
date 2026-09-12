import { stableJson } from '../../contracts/sync.js';
import { reconcileTurns } from "../../usage/canonical.js";
import type { Candidate, CanonicalEvent, EventDelta } from "../../usage/types.js";
import { chunks, type Domain, type EntityMutation } from "../publication/store.js";
import { metricStatements } from "../publication/metrics.js";
import { assignmentRules, effectiveOrigin, withAssignment, type UserAssignment } from "../../organization/worker/origin-rules.js";
import { reconcileOriginEvidence } from "../../usage/origin-evidence.js";
import { type CandidateRow } from '../../usage/candidate-row.js';
import { canonicalFromRows } from './canonical.js';

const pair=(c:Pick<Candidate,'thread_id'|'turn_id'>)=>stableJson([c.thread_id,c.turn_id]);

const candidateValue=(r:CandidateRow)=>JSON.parse(r.candidate) as Candidate;

function byEvent(rows:Iterable<CandidateRow>):Map<string,CandidateRow[]> {
  const groups=new Map<string,CandidateRow[]>();for(const row of rows){const group=groups.get(row.event_id);if(group)group.push(row);else groups.set(row.event_id,[row]);}return groups;
}

/** All event candidates are loaded before filtering by their actual execution origin. */
export async function prepareMaterialization(db:D1Database,h:Domain,initial:CandidateRow[],mutations:Map<string,CandidateRow|null>,additionalIds:string[]=[],preserveRemovedOrigins=false):Promise<{statements:D1PreparedStatement[];changes:EntityMutation[];deltas:EventDelta[]}> {
  const current=new Map(initial.map(r=>[r.observation_id,r])),ids=new Set(additionalIds),turns=new Set<string>();
  for(const r of initial){ids.add(r.event_id);if(r.turn_id!==null)turns.add(pair(r));}
  for(const [id,r] of mutations){const old=current.get(id);if(old){ids.add(old.event_id);if(old.turn_id!==null)turns.add(pair(old));}if(r){ids.add(r.event_id);if(r.turn_id!==null)turns.add(pair(r));}}
  if(turns.size){const more=await db.prepare(`SELECT c.* FROM json_each(?) p CROSS JOIN v3_candidates c WHERE c.user_id=? AND c.thread_id=json_extract(p.value,'$[0]') AND c.turn_id IS json_extract(p.value,'$[1]') AND c.active=1 AND json_extract(c.candidate,'$.kind')='legacy'`).bind(stableJson([...turns].map(s=>JSON.parse(s))),h.user_id).all<CandidateRow>();for(const r of more.results){current.set(r.observation_id,r);ids.add(r.event_id);}}
  if(ids.size){for(const group of chunks([...ids])){const more=await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND active=1 AND event_id IN(SELECT value FROM json_each(?))').bind(h.user_id,stableJson(group)).all<CandidateRow>();for(const r of more.results)current.set(r.observation_id,r);}}
  const before=byEvent(current.values());
  for(const [id,row] of mutations){if(row)current.set(id,row);else current.delete(id);}
  const grouped=byEvent(current.values());
  for(const id of ids)for(const updated of reconcileOriginEvidence(grouped.get(id)||[],before.get(id)||[],preserveRemovedOrigins)){
    if(updated.candidate!==current.get(updated.observation_id)!.candidate){current.set(updated.observation_id,updated);mutations.set(updated.observation_id,updated);}}
  const visible=[...current.values()].filter(r=>r.active).map(candidateValue);
  // Explicit records in a turn suppress its cumulative token records even when their event IDs differ.
  const candidateTurns=[...new Set(visible.filter(c=>c.turn_id!==null&&c.kind==='legacy'&&!c.excluded).map(pair))];
  const removedExplicit=[...mutations.keys()],externalTurns=new Set<string>();
  if(candidateTurns.length){const explicit=await db.prepare(`SELECT json_extract(p.value,'$[0]') thread_id,json_extract(p.value,'$[1]') turn_id FROM json_each(?) p WHERE EXISTS(SELECT 1 FROM v3_candidates c WHERE c.user_id=? AND c.thread_id=json_extract(p.value,'$[0]') AND c.turn_id IS json_extract(p.value,'$[1]') AND c.active=1 AND json_extract(c.candidate,'$.kind')='record' AND json_extract(c.candidate,'$.excluded')=0 AND c.observation_id NOT IN(SELECT value FROM json_each(?)))`).bind(stableJson(candidateTurns.map(s=>JSON.parse(s))),h.user_id,stableJson(removedExplicit)).all<{thread_id:string;turn_id:string}>();for(const r of explicit.results)externalTurns.add(pair(r));}
  const eligible=new Set(reconcileTurns(visible).filter(c=>c.kind==='record'||c.turn_id===null||!externalTurns.has(pair(c))).map(c=>c.observation_id)),canonical=new Map<string,CanonicalEvent|null>(),allowed=byEvent([...current.values()].filter(r=>eligible.has(r.observation_id)));
  for(const id of ids)canonical.set(id,await canonicalFromRows(allowed.get(id)||[]));
  return materializeCanonical(db,h,canonical);
}

export async function materializeCanonical(db:D1Database,h:Domain,canonical:Map<string,CanonicalEvent|null>,overrides?:Map<string,UserAssignment|null>):Promise<{statements:D1PreparedStatement[];changes:EntityMutation[];deltas:EventDelta[]}> {
  const ids=[...canonical.keys()],oldEvents=new Map<string,{payload:string;revision:number}>();
  // Natural evidence always wins and deleted events cannot acquire an assignment.
  const assignable=ids.filter(id=>{const event=canonical.get(id);return event&&!event.origin_device_id&&!event.origin_conflict&&!overrides?.has(id);});
  const reads=chunks(ids).map(group=>db.prepare('SELECT entity_id,payload,revision FROM v3_entity_versions WHERE user_id=? AND epoch=? AND kind=\'event\' AND valid_to IS NULL AND entity_id IN(SELECT value FROM json_each(?))').bind(h.user_id,h.active_epoch,stableJson(group)));
  const [rules,loaded]=await Promise.all([assignmentRules(db,h.user_id,assignable),reads.length?db.batch<{entity_id:string;payload:string;revision:number}>(reads):Promise.resolve([])]);
  for(const id of ids)canonical.set(id,withAssignment(canonical.get(id)!,overrides?.has(id)?overrides.get(id)!:rules.get(id)??null));
  for(const result of loaded)for(const row of result.results)oldEvents.set(row.entity_id,row);
  const deltas:EventDelta[]=[],changes:EntityMutation[]=[];
  for(const id of ids){const old=oldEvents.get(id),before:CanonicalEvent|null=old?.payload?JSON.parse(old.payload):null,after=canonical.get(id)!;if(stableJson(before)===stableJson(after))continue;deltas.push({event_id:id,before,after});changes.push({kind:'event',id,revision:(old?.revision||0)+1,value:after,at:after?.at||before?.at,thread_id:after?.thread_id||before?.thread_id,origin_device_id:effectiveOrigin(after)});}
  const statements:D1PreparedStatement[]=[];
  for(const group of chunks(changes.filter(c=>c.value!==null).map(c=>({id:c.id,revision:c.revision,...c.value as CanonicalEvent,origin_device_id:c.origin_device_id,payload:stableJson(c.value)}))))statements.push(db.prepare(`INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,turn_id,origin_device_id,source_project_id,project,model,effort,payload)
    SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.revision'),json_extract(value,'$.at'),json_extract(value,'$.thread_id'),json_extract(value,'$.turn_id'),json_extract(value,'$.origin_device_id'),json_extract(value,'$.source_project_id'),json_extract(value,'$.project'),json_extract(value,'$.model'),json_extract(value,'$.effort'),json_extract(value,'$.payload') FROM json_each(?) WHERE true
    ON CONFLICT(user_id,epoch,event_id) DO UPDATE SET revision=excluded.revision,at=excluded.at,thread_id=excluded.thread_id,turn_id=excluded.turn_id,origin_device_id=excluded.origin_device_id,source_project_id=excluded.source_project_id,project=excluded.project,model=excluded.model,effort=excluded.effort,payload=excluded.payload`).bind(h.user_id,h.active_epoch,stableJson(group)));
  const removed=changes.filter(c=>c.value===null).map(c=>c.id);if(removed.length)statements.push(db.prepare('DELETE FROM v3_events WHERE user_id=? AND epoch=? AND event_id IN(SELECT value FROM json_each(?))').bind(h.user_id,h.active_epoch,stableJson(removed)));
  statements.push(...await metricStatements(db,h,deltas));
  return {statements,changes,deltas};
}
