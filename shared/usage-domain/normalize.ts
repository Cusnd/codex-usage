import { stableJson } from '../sync-v3.js';
import { normalizeSourcePath } from './paths.js';
import { TOKEN_FIELDS, type Tokens, type ProjectedRecord, type ExtractionContext, type LegacyState, type Observation, type DependencyView, type ConsumeResult, type Candidate, type ThreadChange, type ServiceTier, type ServiceTierState } from './types.js';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
export const timestamp = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function decimal(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return typeof v === 'string' && /^\d{1,128}$/.test(v) ? BigInt(v).toString() : null;
}
export function normalizeTokens(value: unknown): Tokens {
  const v = object(value), input = object(v.input_tokens_details), output = object(v.output_tokens_details);
  return {
    input_tokens: decimal(v.input_tokens), cached_input_tokens: decimal(v.cached_input_tokens ?? input.cached_tokens),
    cache_write_input_tokens: decimal(v.cache_write_input_tokens ?? v.cache_write_tokens ?? input.cache_write_tokens),
    output_tokens: decimal(v.output_tokens), reasoning_output_tokens: decimal(v.reasoning_output_tokens ?? output.reasoning_tokens),
    total_tokens: decimal(v.total_tokens),
  };
}
export function initialContext(threadId: string): ExtractionContext {
  return {thread_id:threadId,turn_id:null,cwd:null,model:null,effort:null,forked_from_id:null,subagent_parent_id:null,source_project_id:null,service_tier_state:initialTierState()};
}
const initialTierState = ():ServiceTierState => ({configured:'unknown',active_turn_id:null,turn_tier:'unknown',ambiguous:false,revision:0});
export function normalizeServiceTier(value:unknown):ServiceTier {
  if(value==='priority'||value==='fast')return 'fast';
  return value==='default'||value==='standard'?'standard':'unknown';
}
function beginTurn(state:ServiceTierState,turn:string|null):ServiceTierState {
  return !turn||state.active_turn_id===turn?state:{...state,active_turn_id:turn,turn_tier:state.configured,ambiguous:false};
}
export function nextContext(context: ExtractionContext, record: ProjectedRecord): ExtractionContext {
  const p = object(record.payload);
  if (record.type === 'session_meta') return {
    ...initialContext(text(p.id) || text(p.session_id) || context.thread_id), cwd:normalizeSourcePath(p.cwd),
    forked_from_id:text(p.forked_from_id), subagent_parent_id:text(object(object(object(p.source).subagent).thread_spawn).parent_thread_id),
    service_tier_state:{...initialTierState(),revision:(context.service_tier_state?.revision??0)+1},
  };
  const tier=context.service_tier_state??initialTierState();
  if (record.type === 'turn_context') return {...context,turn_id:text(p.turn_id),cwd:normalizeSourcePath(p.cwd)||context.cwd,model:text(p.model),effort:text(p.effort),service_tier_state:beginTurn(tier,text(p.turn_id))};
  if(record.type==='event_msg'&&p.type==='thread_settings_applied') {
    // A copied parent or sibling settings event must never configure this thread.
    if(text(p.thread_id)!==context.thread_id)return context;
    const settings=object(p.thread_settings);if(!Object.hasOwn(settings,'service_tier'))return context;
    const configured=normalizeServiceTier(settings.service_tier),changed=configured!==tier.configured;
    return {...context,service_tier_state:{...tier,configured,revision:tier.revision+Number(changed),ambiguous:tier.ambiguous||!!tier.active_turn_id&&changed}};
  }
  if(record.type==='event_msg'&&p.type==='task_started')return {...context,service_tier_state:beginTurn(tier,text(p.turn_id))};
  if(record.type==='event_msg'&&(p.type==='task_complete'||p.type==='turn_aborted')&&text(p.turn_id)===tier.active_turn_id)return {...context,service_tier_state:{...tier,active_turn_id:null,turn_tier:'unknown',ambiguous:false}};
  return context;
}
/** Only these fields can be retained or transmitted. Unrelated JSON content is discarded immediately. */
export function projectRecord(value: unknown, kind: 'session' | 'titles' = 'session'): {record?: ProjectedRecord; issue?: string} {
  const row = object(value), p = object(row.payload);
  if (kind === 'titles') {
    const id=text(row.id),title=text(row.thread_name),at=timestamp(row.updated_at);
    if (!id || !title || !at) return {issue:'invalid-title-record'};
    return {record:{type:'session_title',payload:{id,thread_name:title,updated_at:at}}};
  }
  const at = typeof row.timestamp === 'string' ? row.timestamp : null;
  const pick = (keys:string[]) => Object.fromEntries(keys.filter(k => typeof p[k] === 'string').map(k => [k,p[k]]));
  if (row.type === 'session_meta') {
    const payload=pick(['id','session_id','cwd','timestamp','thread_source','forked_from_id']);
    if (typeof p.source === 'string') payload.source=p.source;
    else { const parent=text(object(object(object(p.source).subagent).thread_spawn).parent_thread_id);
      if(parent)payload.source={subagent:{thread_spawn:{parent_thread_id:parent}}}; }
    return {record:{type:'session_meta',timestamp:at,payload}};
  }
  if (row.type === 'turn_context') return {record:{type:'turn_context',timestamp:at,payload:pick(['turn_id','cwd','model','effort'])}};
  if (row.type === 'token_usage_record') return {record:{type:'token_usage_record',timestamp:at,payload:{...pick(['thread_id','turn_id','response_id','service_tier']),usage:normalizeTokens(p.usage)}}};
  if(row.type==='event_msg'&&p.type==='thread_settings_applied') {
    const settings=object(p.thread_settings),retained:Record<string,unknown>={};
    // Preserve an explicit null reset; absent service_tier means no mode update.
    if(typeof settings.service_tier==='string'||settings.service_tier===null)retained.service_tier=settings.service_tier;
    return {record:{type:'event_msg',timestamp:at,payload:{type:p.type,...pick(['thread_id']),thread_settings:retained}}};
  }
  if(row.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(p.type))return {record:{type:'event_msg',timestamp:at,payload:{type:p.type,...pick(['turn_id'])}}};
  if (row.type === 'event_msg' && p.type === 'token_count' && p.info && typeof p.info==='object') {
    const info:Record<string,Tokens>={};
    for(const k of ['total_token_usage','last_token_usage'])if(p.info[k] != null)info[k]=normalizeTokens(p.info[k]);
    const payload:Record<string,unknown>={type:'token_count',info};
    const limit=text(object(p.rate_limits).limit_id); if(limit)payload.rate_limits={limit_id:limit};
    return {record:{type:'event_msg',timestamp:at,payload}};
  }
  return {};
}
export function initialLegacyState(threadId: string): LegacyState {
  return {thread_id:threadId,high:null,signatures:{},previous:null,parent_id:null,inherited:false,cutoff:null,deferred:false,issues:0};
}
export function eventIdentity(observation: Observation, responseId: string | null, threadId: string) {
  if(responseId)return {event_id:'response:'+responseId,identity_quality:'response' as const};
  if(observation.session_trusted)return {event_id:'lineage:'+encodeURIComponent(threadId)+':'+observation.prefix_hash,identity_quality:'verified_prefix' as const};
  return {event_id:'position:'+observation.observation_id,identity_quality:'source_position' as const};
}
export function consumeProjected(previous: LegacyState, observation: Observation, dependencies: DependencyView): ConsumeResult {
  const state:LegacyState={...previous,high:previous.high?{...previous.high}:null,signatures:{...previous.signatures}};
  const result:ConsumeResult={state,candidates:[],threads:[],dependencies:[]};
  const r=observation.record,c=observation.context;
  if(observation.issue)state.issues++;
  if(!r)return result;
  const p=object(r.payload);
  if(r.type==='session_title') {
    result.threads.push({id:String(p.id),project:null,source_project_id:null,source:null,parent_id:null,subagent_parent_id:null,forked_from_id:null,title:String(p.thread_name),title_updated_at:String(p.updated_at)});
    return result;
  }
  if(r.type==='session_meta') {
    if(state.thread_id!==c.thread_id)Object.assign(state,initialLegacyState(c.thread_id));
    state.parent_id=c.forked_from_id||c.subagent_parent_id;
    state.inherited=!!state.parent_id;state.cutoff=timestamp(p.timestamp||r.timestamp);state.deferred=false;
    result.threads.push({id:c.thread_id,project:c.cwd,source_project_id:c.source_project_id,source:text(p.source)||text(p.thread_source),parent_id:state.parent_id,subagent_parent_id:c.subagent_parent_id,forked_from_id:c.forked_from_id});
    return result;
  }
  if(r.type==='turn_context')return result;
  const at=timestamp(r.timestamp);if(!at){state.issues++;return result;}
  const make=(tokens:Tokens,kind:'record'|'legacy',signature:string|null,incomplete:boolean,excluded:boolean,ambiguousCumulative=false):Candidate => {
    const thread=kind==='record'?(text(p.thread_id)||c.thread_id):c.thread_id;
    const response=kind==='record'?text(p.response_id):null;
    const turn=kind==='record'?(text(p.turn_id)||c.turn_id):c.turn_id,tier=c.service_tier_state;
    const direct=kind==='record'&&Object.hasOwn(p,'service_tier');
    // Configuration-only inference requires an identified, stable active turn.
    const configured=thread===c.thread_id&&turn!==null&&tier?.active_turn_id===turn&&!tier.ambiguous&&!ambiguousCumulative?tier.turn_tier:'unknown';
    const service_tier=direct?normalizeServiceTier(p.service_tier):configured;
    const service_tier_source=direct?'record':service_tier==='unknown'?'unknown':'settings';
    return {...tokens,...eventIdentity(observation,response,thread),observation_id:observation.observation_id,record_revision:observation.record_revision,
      source_id:observation.source_id,generation:observation.generation,thread_id:thread,turn_id:turn,
      response_id:response,at,project:c.cwd,source_project_id:c.source_project_id,model:c.model,effort:c.effort,kind,signature,
      incomplete,excluded,origin:{...observation.origin},service_tier,service_tier_source};
  };
  if(r.type==='token_usage_record') {
    const tokens=normalizeTokens(p.usage);if(tokens.total_tokens===null){state.issues++;return result;}
    result.candidates.push(make(tokens,'record',null,!p.response_id,false));return result;
  }
  if(r.type!=='event_msg'||p.type!=='token_count')return result;
  const info=object(p.info),total=info.total_token_usage?normalizeTokens(info.total_token_usage):null,last=info.last_token_usage?normalizeTokens(info.last_token_usage):null;
  if(!total&&!last)return result;
  const ambiguousCumulative=!last&&(!previous.high||previous.service_tier_revision!==c.service_tier_state?.revision);
  if(total){
    const rollback=TOKEN_FIELDS.some(k=>total[k]!==null&&previous.high?.[k]!==undefined&&BigInt(total[k]!)<BigInt(previous.high[k]!));
    state.service_tier_revision=rollback?null:c.service_tier_state?.revision??null;
  }
  const signature=stableJson([total,last]),limit=text(object(p.rate_limits).limit_id)||'default';
  const duplicate=!!total&&(state.signatures[limit]===signature||state.previous===signature);
  if(total)state.signatures[limit]=signature;state.previous=signature;
  let tokens=last,incomplete=false;
  if(!tokens&&total) {
    tokens={...total};for(const k of TOKEN_FIELDS)if(total[k]!==null){const v=BigInt(total[k]),high=BigInt(state.high?.[k]||'0');if(v<high){incomplete=true;tokens[k]='0';}else tokens[k]=(v-high).toString();}
    if(!state.high&&state.parent_id)incomplete=true;
  }
  if(total){state.high??={};for(const k of TOKEN_FIELDS)if(total[k]!==null&&BigInt(total[k])>=BigInt(state.high[k]||'0'))state.high[k]=total[k];}
  if(incomplete)state.issues++;
  if(duplicate||!tokens||tokens.total_tokens==='0')return result;
  let excluded=false;
  if(state.inherited&&state.parent_id) {
    const cutoff=state.cutoff||at;result.dependencies.push(state.parent_id);
    if(dependencies.parentHasSignature(state.parent_id,signature,cutoff))excluded=true;
    else if(dependencies.parentStatus(state.parent_id,cutoff)==='complete')state.inherited=false;
    else {excluded=true;incomplete=true;state.deferred=true;state.issues++;}
  }
  if(tokens.total_tokens===null){state.issues++;return result;}
  result.candidates.push(make(tokens,'legacy',signature,incomplete,excluded,ambiguousCumulative));return result;
}
