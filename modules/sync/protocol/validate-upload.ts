import type { ExtractionContext } from "../../usage/types.js";
import { projectRecord } from "../../usage/normalize.js";
import { SYNC_PROTOCOL, SYNC_SCHEMA, EXTRACTOR_VERSION } from "../../contracts/sync-version.js";
import { stableJson } from "../../foundation/stable-json.js";
import { type UploadBatch, V3_MAX_RECORDS, type SourceCheckpoint } from '../../contracts/sync.js';

const obj=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

const keys=(value:Record<string,unknown>,required:string[],optional:string[]=[])=>required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));

const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=1024;

const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min;

function validContext(v:unknown):v is ExtractionContext {
  if(!obj(v)||!keys(v,['thread_id','turn_id','cwd','model','effort','forked_from_id','subagent_parent_id','source_project_id'],['service_tier_state'])||!id(v.thread_id)||
    !Object.entries(v).every(([k,x])=>k==='thread_id'||k==='service_tier_state'||x===null||typeof x==='string'&&x.length>0&&x.length<=(k==='cwd'?8192:1024)))return false;
  const tier=v.service_tier_state;
  return tier===undefined||obj(tier)&&keys(tier,['configured','active_turn_id','turn_tier','ambiguous','revision'])&&
    ['standard','fast','unknown'].includes(String(tier.configured))&&['standard','fast','unknown'].includes(String(tier.turn_tier))&&
    (tier.active_turn_id===null||id(tier.active_turn_id))&&typeof tier.ambiguous==='boolean'&&integer(tier.revision);
}

export function validProjectedRecord(v:unknown):boolean {
  if(!obj(v)||!keys(v,['type','payload'],['timestamp'])||!obj(v.payload))return false;
  // Reprojecting a projected record is idempotent. Equality rejects every unlisted nested field.
  const projected=v.type==='session_title'?projectRecord(v.payload,'titles').record:projectRecord(v).record;
  if(!projected||stableJson(v)!==stableJson(projected))return false;
  const bounded=(x:unknown):boolean=>x===null||typeof x==='string'&&x.length<=8192||typeof x==='number'&&Number.isSafeInteger(x)||obj(x)&&Object.values(x).every(bounded);
  return bounded(v);
}

export function validUploadBatch(value:unknown):value is UploadBatch {
  if(!obj(value)||!keys(value,['protocol','schema_version','extractor_version','collector_id','producer_epoch','lane','lane_seq','batch_id','records_hash','sources','records','metadata']))return false;
  if(value.protocol!==SYNC_PROTOCOL||value.schema_version!==SYNC_SCHEMA||value.extractor_version!==EXTRACTOR_VERSION||!integer(value.extractor_version,1)||!id(value.collector_id)||!id(value.producer_epoch)||!id(value.batch_id)||
    !['live','backfill'].includes(String(value.lane))||!integer(value.lane_seq,1)||!hash(value.records_hash)||
    !Array.isArray(value.sources)||value.sources.length>64||!Array.isArray(value.records)||value.records.length>V3_MAX_RECORDS||!Array.isArray(value.metadata)||value.metadata.length>500||!value.sources.length&&(!value.metadata.length||value.records.length))return false;
  const sources=new Map<string,SourceCheckpoint>();
  for(const s of value.sources) {
    if(!obj(s)||!keys(s,['source_id','generation','kind','from_cursor','to_cursor','snapshot_eof','context_hash','context','replace_start','replace_end','generation_complete','available','trailing_bytes'])||
      !id(s.source_id)||!integer(s.generation,1)||!['session','titles'].includes(String(s.kind))||!integer(s.from_cursor)||!integer(s.to_cursor)||!integer(s.snapshot_eof)||
      Number(s.from_cursor)>Number(s.to_cursor)||Number(s.to_cursor)>Number(s.snapshot_eof)||!hash(s.context_hash)||!validContext(s.context)||
      !['replace_start','replace_end','generation_complete','available'].every(k=>typeof s[k]==='boolean')||!integer(s.trailing_bytes)||
      s.replace_start&&s.from_cursor!==0||s.replace_end&&!s.generation_complete||s.generation_complete&&Number(s.trailing_bytes)!==Number(s.snapshot_eof)-Number(s.to_cursor))return false;
    const key=stableJson([s.source_id,s.generation]);if(sources.has(key))return false;sources.set(key,s as unknown as SourceCheckpoint);
  }
  const observations=new Set<string>(),ends=new Map<string,number>();
  for(const o of value.records) {
    if(!obj(o)||!keys(o,['observation_id','record_revision','source_id','generation','locator','byte_end','prefix_hash','session_trusted','origin','context','record'],['issue'])||
      !id(o.observation_id)||observations.has(String(o.observation_id))||!integer(o.record_revision,1)||!id(o.source_id)||!integer(o.generation,1)||!integer(o.locator)||!integer(o.byte_end)||
      Number(o.byte_end)<=Number(o.locator)||!hash(o.prefix_hash)||typeof o.session_trusted!=='boolean'||!validContext(o.context)||
      !obj(o.origin)||!keys(o.origin,['device_id','kind'])||!(o.origin.device_id===null||id(o.origin.device_id))||!['execution','preserved','local_append','observed_local','unknown'].includes(String(o.origin.kind))||
      !(o.record===null||validProjectedRecord(o.record))||o.issue!==undefined&&!(typeof o.issue==='string'&&/^[a-z0-9_-]{1,80}$/.test(o.issue)))return false;
    if(o.origin.kind==='unknown'&&o.origin.device_id!==null)return false;
    const key=stableJson([o.source_id,o.generation]),source=sources.get(key);
    if(!source||Number(o.locator)<(ends.get(key)??source.from_cursor)||Number(o.byte_end)>source.to_cursor)return false;
    ends.set(key,Number(o.byte_end));observations.add(String(o.observation_id));
  }
  for(const m of value.metadata) {
    if(!obj(m))return false;
    if(m.type==='source_availability') {if(!keys(m,['type','source_id','available'])||!id(m.source_id)||typeof m.available!=='boolean')return false;}
    else if(m.type==='project') {
      if(!keys(m,['type','source_project_id','value'])||!id(m.source_project_id)||!obj(m.value)||
        Object.keys(m.value).some(k=>!['id','kind','name','root','app_project_id','repository','common_dir','confidence','reason','thread_ids'].includes(k))||
        Object.entries(m.value).some(([k,v])=>k==='thread_ids'?!(Array.isArray(v)&&v.length<=500&&v.every(id)):!(v===null||typeof v==='string'&&v.length<=8192)))return false;
    } else return false;
  }
  return true;
}
