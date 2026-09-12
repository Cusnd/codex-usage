import { stableJson, type UploadBatch } from '../../../shared/sync-v3';
import { consumeProjected, initialLegacyState } from '../../../shared/usage-domain/normalize';
import { canonicalize, reconcileTurns } from '../../../shared/usage-domain/canonical';
import type { Candidate, CanonicalEvent, EventDelta, LegacyState, Observation, ThreadChange } from '../../../shared/usage-domain/types';
import { fail, sha256 } from '../http';
import { advanceHead, assertWritableDevice, chunks, endGuard, entityStatements, guard, isCasFailure, progressStatements, type Domain, type EntityMutation, type JobLease, type Receipt, type WriteDevice } from './store';
import { metricStatements } from './metrics';
import { prepareProjectMetadata } from './projects';
import { rebuildPublication,startReplacement } from './rebuild';
import { prepareHandoff } from './legacy';
import { pendingLegacySources } from './legacy-staging';
import { measured,type SyncTiming } from './timing';
import { assignmentRules,effectiveOrigin,withAssignment,type UserAssignment } from './origin-rules';
import { candidatesWithOriginEvidence,reconcileOriginEvidence } from './origin-evidence';

type SourceRow={user_id:string;collector_id:string;source_id:string;generation:number;kind:string;cursor:number;snapshot_eof:number;context_hash:string;context:string;legacy_state:string|null;active:number;complete:number;available:number;trailing_bytes:number};
export type CandidateRow={observation_id:string;uploader_device_id:string;collector_id:string;source_id:string;generation:number;record_revision:number;event_id:string;thread_id:string;turn_id:string|null;at:string;signature:string|null;active:number;candidate:string;origin_claim?:string|null};
type SavedObservation={observation_id:string;record_revision:number;content_hash:string;collector_id:string;source_id:string;generation:number};
const pair=(c:Pick<Candidate,'thread_id'|'turn_id'>)=>stableJson([c.thread_id,c.turn_id]);
const candidateValue=(r:CandidateRow)=>JSON.parse(r.candidate) as Candidate;
const sourceKey=(s:{source_id:string;generation:number})=>stableJson([s.source_id,s.generation]);
function byEvent(rows:Iterable<CandidateRow>):Map<string,CandidateRow[]> {
  const groups=new Map<string,CandidateRow[]>();for(const row of rows){const group=groups.get(row.event_id);if(group)group.push(row);else groups.set(row.event_id,[row]);}return groups;
}
export const scopedProjectId=async(collector:string,id:string|null)=>id===null?null:'pc1:'+await sha256(stableJson([collector,id]));
export async function canonicalFromRows(rows:CandidateRow[]):Promise<CanonicalEvent|null>{const value=canonicalize(rows.flatMap(candidatesWithOriginEvidence));if(!value)return null;const selected=rows.find(r=>r.observation_id===value.selected_observation_id)!;return {...value,source_project_id:await scopedProjectId(selected.collector_id,value.source_project_id)};}

async function dependencies(db:D1Database,user:string,records:Observation[]) {
  const ids=[...new Set(records.map(r=>r.context.forked_from_id||r.context.subagent_parent_id).filter((x):x is string=>!!x))];
  const signatures=ids.length?(await db.prepare('SELECT thread_id,signature,at FROM v3_candidates WHERE user_id=? AND active=1 AND signature IS NOT NULL AND thread_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(ids)).all<{thread_id:string;signature:string;at:string}>()).results:[];
  const complete=ids.length?(await db.prepare(`SELECT DISTINCT t.thread_id FROM v3_source_threads t JOIN v3_sources s USING(user_id,collector_id,source_id,generation) WHERE t.user_id=? AND s.active=1 AND s.complete=1 AND t.thread_id IN(SELECT value FROM json_each(?))`).bind(user,stableJson(ids)).all<{thread_id:string}>()).results:[];
  return {parentStatus:(id:string,_cutoff:string):'complete'|'partial'|'missing'=>complete.some(r=>r.thread_id===id)?'complete':signatures.some(r=>r.thread_id===id)?'partial':'missing',parentHasSignature:(id:string,s:string,cut:string)=>signatures.some(r=>r.thread_id===id&&r.signature===s&&r.at<=cut)};
}
function verifyOrigin(device:string,observation:Observation,ownedDevices:Set<string>):Observation {
  const origin=observation.origin;if(!origin.device_id||origin.kind==='unknown')return observation;
  if(origin.kind==='observed_local')return {...observation,origin:{kind:'unknown',device_id:null}};
  if(origin.kind!=='preserved'){
    if(origin.device_id!==device)fail(400,'INVALID_ORIGIN_EVIDENCE','执行证据必须属于当前设备。');return observation;
  }
  if(!ownedDevices.has(origin.device_id))fail(400,'INVALID_ORIGIN_EVIDENCE','执行来源不属于当前空间。');
  return {...observation,origin:{kind:'unknown',device_id:null}};
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
  // Explicit records in a turn suppress its compatibility records even when their event IDs differ.
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

export async function applyBatch(db:D1Database,user:string,b:UploadBatch,job?:JobLease,publishEpoch?:string,timing?:SyncTiming):Promise<boolean> {
  for(let attempt=0;attempt<3;attempt++){
    timing?.count('apply_attempts');
    const loaded=await measured(timing,'apply_load',()=>db.batch([
      db.prepare('SELECT * FROM v3_receipts WHERE user_id=? AND batch_id=?').bind(user,b.batch_id),
      db.prepare('SELECT * FROM v3_sync_domains WHERE user_id=?').bind(user),
      db.prepare('SELECT d.* FROM devices d JOIN v3_receipts r ON r.user_id=d.user_id AND r.device_id=d.id WHERE r.user_id=? AND r.batch_id=?').bind(user,b.batch_id),
      db.prepare('SELECT applied_seq FROM v3_producer_progress WHERE user_id=? AND collector_id=? AND producer_epoch=? AND lane=?').bind(user,b.collector_id,b.producer_epoch,b.lane),
      db.prepare('SELECT * FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson(b.sources.map(s=>s.source_id))),
      db.prepare('SELECT * FROM v3_observations WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(b.records.map(r=>r.observation_id))),
      db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(b.records.map(r=>r.observation_id))),
      ...b.records.some(r=>r.origin.kind==='preserved'&&r.origin.device_id)?[db.prepare('SELECT id FROM devices WHERE user_id=? AND id IN(SELECT value FROM json_each(?))').bind(user,stableJson([...new Set(b.records.filter(r=>r.origin.kind==='preserved').map(r=>r.origin.device_id))]))]:[],
    ]));
    const saved=loaded[0].results[0] as Receipt|undefined;if(!saved)throw Error('missing receipt');if(saved.status==='applied')return true;if(saved.status!=='received')return false;
    const device=assertWritableDevice(loaded[2].results[0] as WriteDevice|null),h=loaded[1].results[0] as Domain|undefined;if(!h)return false;if(publishEpoch?(h.mode!=='rebuilding'||h.rebuild_job!==job?.job_id):(h.mode!=='ready'||h.legacy_baseline_pending))return false;
    const publication=publishEpoch?{...h,active_epoch:publishEpoch,commit_seq:0}:h;
    const progress=(loaded[3].results[0] as {applied_seq:number}|undefined)?.applied_seq;
    if(b.lane_seq!==(progress||0)+1)return false;
    const sources=loaded[4].results as SourceRow[],priorObservations=loaded[5].results as SavedObservation[],inputOld=loaded[6].results as CandidateRow[];
    const observationsById=new Map(priorObservations.map(r=>[r.observation_id,r])),ownedDevices=new Set((loaded[7]?.results as {id:string}[]|undefined)?.map(r=>r.id));
    const dep=await dependencies(db,user,b.records),candidateMutations=new Map<string,CandidateRow|null>(),sourceUpdates:SourceRow[]=[],observationUpdates:SavedObservation[]=[],threadWrites:{source_id:string;generation:number;thread_id:string;payload:string}[]=[],deferred:{observation_id:string;source_id:string;generation:number;locator:number;observation:string}[]=[],resolvedIds:string[]=[],dependencyRows:{source_id:string;generation:number;parent_thread_id:string;initial_state:string}[]=[],replacements:SourceRow[]=[];
    const migrationPending=await pendingLegacySources(db,h,device,b);
    for(const source of b.sources){
      const same=sources.find(s=>s.source_id===source.source_id&&s.generation===source.generation),active=sources.find(s=>s.source_id===source.source_id&&s.active),latest=Math.max(0,...sources.filter(s=>s.source_id===source.source_id).map(s=>s.generation));
      if(source.generation<latest)fail(409,'STALE_GENERATION','来源代次已更新。');
      if(source.from_cursor!==(same?.cursor||0)||!same&&!source.replace_start) return false;
      let state:LegacyState=same?.legacy_state?JSON.parse(same.legacy_state):initialLegacyState(source.context.thread_id);
      const replace=!!active&&active.generation!==source.generation,visible=(!replace||source.generation_complete&&source.replace_end)&&!migrationPending.has(sourceKey(source));
      const next:SourceRow={user_id:user,collector_id:b.collector_id,source_id:source.source_id,generation:source.generation,kind:source.kind,cursor:source.to_cursor,snapshot_eof:source.snapshot_eof,context_hash:source.context_hash,context:stableJson(source.context),legacy_state:null,active:visible?1:0,complete:source.generation_complete?1:0,available:source.available?1:0,trailing_bytes:source.trailing_bytes};
      if(replace&&visible)replacements.push(active!);
      const records=b.records.filter(r=>r.source_id===source.source_id&&r.generation===source.generation);
      for(const original of records){
        const contentHash=await sha256(stableJson(original)),old=observationsById.get(original.observation_id);
        if(old){if(old.collector_id!==b.collector_id||old.source_id!==original.source_id||old.generation!==original.generation)fail(409,'OBSERVATION_CONFLICT','观察来源不可变。');if(old.record_revision>original.record_revision)continue;if(old.record_revision===original.record_revision){if(old.content_hash!==contentHash)fail(409,'REVISION_CONFLICT','同一记录修订包含不同内容。');continue;}}
        const row=verifyOrigin(device.id,original,ownedDevices),beforeState=state,parsed=consumeProjected(state,row,dep);state=parsed.state;
        observationUpdates.push({observation_id:row.observation_id,record_revision:row.record_revision,content_hash:contentHash,collector_id:b.collector_id,source_id:row.source_id,generation:row.generation});
        candidateMutations.set(row.observation_id,null);
        for(const c of parsed.candidates)candidateMutations.set(c.observation_id,{observation_id:c.observation_id,uploader_device_id:device.id,collector_id:b.collector_id,source_id:c.source_id,generation:c.generation,record_revision:c.record_revision,event_id:c.event_id,thread_id:c.thread_id,turn_id:c.turn_id,at:c.at,signature:c.signature,active:visible?1:0,candidate:stableJson({...c,origin_record:{prefix_hash:original.prefix_hash,observed_local:original.origin.kind==='observed_local'}}),origin_claim:original.origin.kind==='preserved'?original.origin.device_id:null});
        for(const t of parsed.threads)threadWrites.push({source_id:row.source_id,generation:row.generation,thread_id:t.id,payload:stableJson({...t,source_project_id:await scopedProjectId(b.collector_id,t.source_project_id)})});
        if(state.parent_id&&state.deferred){deferred.push({observation_id:row.observation_id,source_id:row.source_id,generation:row.generation,locator:row.locator,observation:stableJson(row)});dependencyRows.push({source_id:row.source_id,generation:row.generation,parent_thread_id:state.parent_id,initial_state:stableJson(beforeState)});}else resolvedIds.push(row.observation_id);
      }
      next.legacy_state=stableJson(state);sourceUpdates.push(next);
    }
    const handoff=await prepareHandoff(db,h,device,b);
    if(!publishEpoch&&handoff.plans.length){await startReplacement(db,h,device,b,job,[...sourceUpdates,...handoff.plans],candidateMutations,threadWrites);return false;}
    if(!publishEpoch&&replacements.length){const n=await db.prepare('SELECT COUNT(*) n FROM v3_candidates WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson(replacements.map(r=>r.source_id))).first<number>('n');if((n||0)>500){await startReplacement(db,h,device,b,job,sourceUpdates,candidateMutations,threadWrites);return false;}}
    const initial=[...inputOld];
    if(!publishEpoch&&replacements.length){const replaced=new Map(replacements.map(s=>[s.source_id,s])),related=await db.prepare('SELECT * FROM v3_candidates WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?))').bind(user,b.collector_id,stableJson([...replaced.keys()])).all<CandidateRow>();for(const r of related.results){const old=replaced.get(r.source_id)!;initial.push(r);if(r.generation===old.generation)candidateMutations.set(r.observation_id,{...r,active:0});else if(r.generation===sourceUpdates.find(s=>s.source_id===old.source_id)!.generation&&!candidateMutations.has(r.observation_id))candidateMutations.set(r.observation_id,{...r,active:1});}}
    // A replacement's final packet may contain no metadata; promote the metadata staged earlier too.
    const replacedSources=replacements.map(old=>({source_id:old.source_id,generation:sourceUpdates.find(s=>s.source_id===old.source_id)!.generation}));
    if(!publishEpoch&&replacedSources.length){const staged=(await db.prepare(`SELECT t.source_id,t.generation,t.thread_id,t.payload FROM json_each(?) j JOIN v3_source_threads t ON t.source_id=json_extract(j.value,'$.source_id') AND t.generation=json_extract(j.value,'$.generation') WHERE t.user_id=? AND t.collector_id=?`).bind(stableJson(replacedSources),user,b.collector_id).all<{source_id:string;generation:number;thread_id:string;payload:string}>()).results;for(const t of staged)if(!threadWrites.some(w=>w.source_id===t.source_id&&w.generation===t.generation&&w.thread_id===t.thread_id))threadWrites.push(t);}
    const materialized=publishEpoch?{statements:[],changes:[]}:await measured(timing,'canonical',()=>prepareMaterialization(db,h,initial,candidateMutations));
    const projects=await measured(timing,'projects',()=>prepareProjectMetadata(db,h,b,device.id)),changes=[...materialized.changes,...projects.changes],threadStatements:D1PreparedStatement[]=[];
    const updatedThreads:{id:string;payload:string;revision:number}[]=[],threadIds=[...new Set(threadWrites.map(t=>t.thread_id))],oldThreads=new Map<string,{payload:string;revision:number}>();
    if(!publishEpoch)for(const group of chunks(threadIds)){const rows=await db.prepare('SELECT thread_id,payload,revision FROM v3_threads WHERE user_id=? AND thread_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(group)).all<{thread_id:string;payload:string;revision:number}>();for(const row of rows.results)oldThreads.set(row.thread_id,row);}
    if(!publishEpoch)for(const id of threadIds){
      const old=oldThreads.get(id);
      let value:ThreadChange|undefined=old?JSON.parse(old.payload):undefined;
      for(const row of threadWrites.filter(t=>t.thread_id===id)){const source=sourceUpdates.find(s=>s.source_id===row.source_id&&s.generation===row.generation);if(!source?.active)continue;const update=JSON.parse(row.payload) as ThreadChange;
        if(update.title!==undefined){if(!value)value=update;else if((update.title_updated_at||'')>=(value.title_updated_at||''))value={...value,title:update.title,title_updated_at:update.title_updated_at};}else value={...value,...update};}
      if(value&&stableJson(value)!==old?.payload){const revision=(old?.revision||0)+1,payload=stableJson(value);updatedThreads.push({id,payload,revision});changes.push({kind:'thread',id,revision,value,thread_id:id});}
    }
    for(const group of chunks(updatedThreads))threadStatements.push(db.prepare(`INSERT INTO v3_threads(user_id,thread_id,payload,revision) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.payload'),json_extract(value,'$.revision') FROM json_each(?) WHERE true ON CONFLICT(user_id,thread_id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision`).bind(user,stableJson(group)));
    const op=crypto.randomUUID(),statements:D1PreparedStatement[]=[guard(db,h,op,device,job)];
    if(publishEpoch&&sourceUpdates.length){const updates=stableJson(sourceUpdates.map(s=>({source_id:s.source_id,generation:s.generation,active:s.active})));statements.push(db.prepare(`UPDATE v3_candidates SET active=(SELECT json_extract(value,'$.active') FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation')) WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation'))`).bind(updates,user,b.collector_id,updates));}
    const availability=new Map<string,number>();for(const m of b.metadata)if(m.type==='source_availability')availability.set(m.source_id,Number(m.available));
    if(availability.size){const updates=stableJson([...availability].map(([source_id,available])=>({source_id,available})));statements.push(db.prepare(`UPDATE v3_sources SET available=(SELECT json_extract(value,'$.available') FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id')) WHERE user_id=? AND collector_id=? AND source_id IN(SELECT json_extract(value,'$.source_id') FROM json_each(?))`).bind(updates,user,b.collector_id,updates));}
    if(replacements.length)statements.push(db.prepare('UPDATE v3_sources SET active=0 WHERE user_id=? AND collector_id=? AND source_id IN(SELECT value FROM json_each(?)) AND active=1').bind(user,b.collector_id,stableJson(replacements.map(s=>s.source_id))));
    for(const group of chunks(sourceUpdates))statements.push(db.prepare(`INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,cursor,snapshot_eof,context_hash,context,legacy_state,active,complete,available,trailing_bytes)
      SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.kind'),json_extract(value,'$.cursor'),json_extract(value,'$.snapshot_eof'),json_extract(value,'$.context_hash'),json_extract(value,'$.context'),json_extract(value,'$.legacy_state'),json_extract(value,'$.active'),json_extract(value,'$.complete'),json_extract(value,'$.available'),json_extract(value,'$.trailing_bytes') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,collector_id,source_id,generation) DO UPDATE SET cursor=excluded.cursor,snapshot_eof=excluded.snapshot_eof,context_hash=excluded.context_hash,context=excluded.context,legacy_state=excluded.legacy_state,active=excluded.active,complete=excluded.complete,available=excluded.available,trailing_bytes=excluded.trailing_bytes`).bind(user,b.collector_id,stableJson(group)));
    const removed=[...candidateMutations].filter(([,r])=>!r).map(([id])=>id);if(removed.length)statements.push(db.prepare('DELETE FROM v3_candidates WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(removed)));
    for(const group of chunks([...candidateMutations.values()].filter((r):r is CandidateRow=>!!r)))statements.push(db.prepare(`INSERT INTO v3_candidates(user_id,observation_id,uploader_device_id,collector_id,source_id,generation,record_revision,event_id,thread_id,turn_id,at,signature,active,candidate,origin_claim)
      SELECT ?,json_extract(value,'$.observation_id'),json_extract(value,'$.uploader_device_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.record_revision'),json_extract(value,'$.event_id'),json_extract(value,'$.thread_id'),json_extract(value,'$.turn_id'),json_extract(value,'$.at'),json_extract(value,'$.signature'),json_extract(value,'$.active'),json_extract(value,'$.candidate'),json_extract(value,'$.origin_claim') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,observation_id) DO UPDATE SET record_revision=excluded.record_revision,event_id=excluded.event_id,thread_id=excluded.thread_id,turn_id=excluded.turn_id,at=excluded.at,signature=excluded.signature,active=excluded.active,candidate=excluded.candidate,origin_claim=excluded.origin_claim`).bind(user,stableJson(group)));
    for(const group of chunks(observationUpdates))statements.push(db.prepare(`INSERT INTO v3_observations(user_id,observation_id,collector_id,source_id,generation,record_revision,content_hash) SELECT ?,json_extract(value,'$.observation_id'),json_extract(value,'$.collector_id'),json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.record_revision'),json_extract(value,'$.content_hash') FROM json_each(?) WHERE true ON CONFLICT(user_id,observation_id) DO UPDATE SET record_revision=excluded.record_revision,content_hash=excluded.content_hash`).bind(user,stableJson(group)));
    for(const group of chunks(threadWrites))statements.push(db.prepare(`INSERT INTO v3_source_threads(user_id,collector_id,source_id,generation,thread_id,payload) SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.thread_id'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT(user_id,collector_id,source_id,generation,thread_id) DO UPDATE SET payload=excluded.payload`).bind(user,b.collector_id,stableJson(group)));
    for(const group of chunks(deferred))statements.push(db.prepare(`INSERT INTO v3_deferred_records(user_id,observation_id,collector_id,source_id,generation,locator,observation) SELECT ?,json_extract(value,'$.observation_id'),?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.locator'),json_extract(value,'$.observation') FROM json_each(?) WHERE true ON CONFLICT(user_id,observation_id) DO UPDATE SET observation=excluded.observation`).bind(user,b.collector_id,stableJson(group)));
    for(const group of chunks(dependencyRows))statements.push(db.prepare(`INSERT INTO v3_dependencies(user_id,collector_id,source_id,generation,parent_thread_id,initial_state) SELECT ?,?,json_extract(value,'$.source_id'),json_extract(value,'$.generation'),json_extract(value,'$.parent_thread_id'),json_extract(value,'$.initial_state') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(user,b.collector_id,stableJson(group)));
    if(resolvedIds.length)statements.push(db.prepare('DELETE FROM v3_deferred_records WHERE user_id=? AND observation_id IN(SELECT value FROM json_each(?))').bind(user,stableJson(resolvedIds)));
    const resolvedSources=sourceUpdates.filter(s=>!JSON.parse(s.legacy_state!).deferred).map(s=>({source_id:s.source_id,generation:s.generation}));
    if(resolvedSources.length)statements.push(db.prepare(`DELETE FROM v3_deferred_records WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation=json_extract(value,'$.generation'))`).bind(user,b.collector_id,stableJson(resolvedSources)));
    const completedParents=[...new Set(b.sources.filter(s=>s.generation_complete).map(s=>s.context.thread_id))];
    if(completedParents.length)statements.push(db.prepare(`INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
      SELECT d.user_id,'dependency:'||d.collector_id||':'||d.source_id||':'||d.generation,'dependency',json_object('collector_id',d.collector_id,'source_id',d.source_id,'generation',d.generation),?,? FROM v3_dependencies d WHERE d.user_id=? AND d.parent_thread_id IN(SELECT value FROM json_each(?))
      ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0 WHERE v3_jobs.state<>'running'`).bind(Date.now(),Date.now(),user,stableJson(completedParents)));
    // Superseded generations are no longer current facts or pending replay inputs.
    if(replacedSources.length)for(const table of ['v3_candidates','v3_observations','v3_source_threads','v3_deferred_records','v3_dependencies','v3_sources'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND collector_id=? AND EXISTS(SELECT 1 FROM json_each(?) WHERE source_id=json_extract(value,'$.source_id') AND generation<json_extract(value,'$.generation'))`).bind(user,b.collector_id,stableJson(replacedSources)));
    statements.push(...materialized.statements,...threadStatements,...projects.statements,...handoff.statements,...await entityStatements(db,publication,changes),
      ...publishEpoch?rebuildPublication(db,h,'apply:'+b.batch_id,publishEpoch):[],
      db.prepare("UPDATE v3_receipts SET status='applied',applied_epoch=?,applied_commit_seq=?,applied_at=?,handoff_results=? WHERE user_id=? AND batch_id=?").bind(publication.active_epoch,publication.commit_seq+Number(changes.length>0),Date.now(),handoff.outcomes.length?stableJson(handoff.outcomes):null,user,b.batch_id),
      db.prepare('UPDATE devices SET protocol=3 WHERE user_id=? AND id=?').bind(user,device.id),
      db.prepare('DELETE FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(user,b.batch_id),
      db.prepare("UPDATE v3_jobs SET state='complete',lease_token=NULL,lease_until=0,updated_at=? WHERE user_id=? AND job_id=?").bind(Date.now(),user,'apply:'+b.batch_id),
      ...progressStatements(db,b,user),advanceHead(db,h,changes.length>0),endGuard(db,user,op));
    try{await measured(timing,'apply_commit',()=>db.batch(statements));return true;}catch(error){if(isCasFailure(error)){timing?.count('cas_retries');continue;}throw error;}
  }
  return false;
}
