import { stableJson, type UploadBatch } from "../../contracts/sync.js";
import { consumeProjected, initialLegacyState } from "../../usage/normalize.js";
import type { LegacyState, Observation } from "../../usage/types.js";
import { fail, sha256 } from "../../platform/worker/http.js";
import { type WriteDevice } from "../publication/store.js";
import { scopedProjectId } from "./canonical.js";
import type { CandidateRow } from "../../usage/candidate-row.js";

export type SourceRow = {
    user_id: string;
    collector_id: string;
    source_id: string;
    generation: number;
    kind: string;
    cursor: number;
    snapshot_eof: number;
    context_hash: string;
    context: string;
    parser_state: string | null;
    active: number;
    complete: number;
    available: number;
    trailing_bytes: number;
};

export type SavedObservation = {
    observation_id: string;
    record_revision: number;
    content_hash: string;
    collector_id: string;
    source_id: string;
    generation: number;
};

function verifyOrigin(device:string,observation:Observation,ownedDevices:Set<string>):Observation {
  const origin=observation.origin;if(!origin.device_id||origin.kind==='unknown')return observation;
  if(origin.kind==='observed_local')return {...observation,origin:{kind:'unknown',device_id:null}};
  if(origin.kind!=='preserved'){
    if(origin.device_id!==device)fail(400,'INVALID_ORIGIN_EVIDENCE','执行证据必须属于当前设备。');return observation;
  }
  if(!ownedDevices.has(origin.device_id))fail(400,'INVALID_ORIGIN_EVIDENCE','执行来源不属于当前空间。');
  return {...observation,origin:{kind:'unknown',device_id:null}};
}

export async function planSources(input:{user:string;b:UploadBatch;device:WriteDevice;sources:SourceRow[];observationsById:Map<string,SavedObservation>;ownedDevices:Set<string>},dep:Parameters<typeof consumeProjected>[2]) {
  const {user,b,device,sources,observationsById,ownedDevices}=input;
    const candidateMutations=new Map<string,CandidateRow|null>(),sourceUpdates:SourceRow[]=[],observationUpdates:SavedObservation[]=[],threadWrites:{source_id:string;generation:number;thread_id:string;payload:string}[]=[],deferred:{observation_id:string;source_id:string;generation:number;locator:number;observation:string}[]=[],resolvedIds:string[]=[],dependencyRows:{source_id:string;generation:number;parent_thread_id:string;initial_state:string}[]=[],replacements:SourceRow[]=[];
    for(const source of b.sources){
      const same=sources.find(s=>s.source_id===source.source_id&&s.generation===source.generation),active=sources.find(s=>s.source_id===source.source_id&&s.active),latest=Math.max(0,...sources.filter(s=>s.source_id===source.source_id).map(s=>s.generation));
      if(source.generation<latest)fail(409,'STALE_GENERATION','来源代次已更新。');
      if(source.from_cursor!==(same?.cursor||0)||!same&&!source.replace_start) return null;
      let state:LegacyState=same?.parser_state?JSON.parse(same.parser_state):initialLegacyState(source.context.thread_id);
      const replace=!!active&&active.generation!==source.generation,visible=(!replace||source.generation_complete&&source.replace_end);
      const next:SourceRow={user_id:user,collector_id:b.collector_id,source_id:source.source_id,generation:source.generation,kind:source.kind,cursor:source.to_cursor,snapshot_eof:source.snapshot_eof,context_hash:source.context_hash,context:stableJson(source.context),parser_state:null,active:visible?1:0,complete:source.generation_complete?1:0,available:source.available?1:0,trailing_bytes:source.trailing_bytes};
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
      next.parser_state=stableJson(state);sourceUpdates.push(next);
    }

  return {candidateMutations,sourceUpdates,observationUpdates,threadWrites,deferred,resolvedIds,dependencyRows,replacements};
}
