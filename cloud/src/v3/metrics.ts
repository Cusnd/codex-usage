import { stableJson } from '../../../shared/sync-v3';
import { TOKEN_FIELDS, type EventDelta, type TokenField } from '../../../shared/usage-domain/types';
import { metricKeys } from '../../../shared/usage-domain/metrics';
import { chunks,type Domain } from './store';
import { effectiveOrigin } from './origin-rules';
const cloudMetricKeys=(event:NonNullable<EventDelta['after']>)=>metricKeys({...event,origin_device_id:effectiveOrigin(event)});

type Summary={key:string;events:number;sums:Record<TokenField,string>;known:Record<TokenField,number>;thread_count:number;turn_count:number};
type Member={aggregate_key:string;kind:'thread'|'turn';member_id:string;refs:number};
const empty=(key:string):Summary=>({key,events:0,sums:Object.fromEntries(TOKEN_FIELDS.map(k=>[k,'0'])) as Summary['sums'],known:Object.fromEntries(TOKEN_FIELDS.map(k=>[k,0])) as Summary['known'],thread_count:0,turn_count:0});
const memberKey=(m:Pick<Member,'aggregate_key'|'kind'|'member_id'>)=>stableJson([m.aggregate_key,m.kind,m.member_id]);
/** Sums are scalar rows; distinct identities have individual reference rows with bounded size. */
export async function metricStatements(db:D1Database,h:Domain,deltas:EventDelta[]):Promise<D1PreparedStatement[]> {
  const keys=[...new Set(deltas.flatMap(d=>[...(d.before?cloudMetricKeys(d.before):[]),...(d.after?cloudMetricKeys(d.after):[])]))],rows=new Map<string,Summary>(),changes=new Map<string,Member>();
  for(const d of deltas)for(const [event,sign] of [[d.before,-1],[d.after,1]] as const)if(event)for(const key of cloudMetricKeys(event)){
    const members:Member[]=[{aggregate_key:key,kind:'thread',member_id:event.thread_id,refs:sign}];if(event.turn_id!==null)members.push({aggregate_key:key,kind:'turn',member_id:stableJson([event.thread_id,event.turn_id]),refs:sign});
    for(const m of members){const id=memberKey(m);changes.set(id,{...m,refs:(changes.get(id)?.refs||0)+sign});}
  }
  const members=[...changes.values()].filter(r=>r.refs!==0),previous=new Map<string,number>(),keyGroups=chunks(keys),memberGroups=chunks(members);
  // Drive from this bounded delta. The full member key uses the primary index rather than
  // scanning every historical member and evaluating a correlated JSON list for each row.
  const reads=[...keyGroups.map(group=>db.prepare('SELECT aggregate_key,payload FROM v3_aggregates WHERE user_id=? AND epoch=? AND aggregate_key IN(SELECT value FROM json_each(?))').bind(h.user_id,h.active_epoch,stableJson(group))),...memberGroups.map(group=>db.prepare(`SELECT m.aggregate_key,m.kind,m.member_id,m.refs FROM json_each(?) j CROSS JOIN v3_aggregate_members m WHERE m.user_id=? AND m.epoch=? AND m.aggregate_key=json_extract(j.value,'$.aggregate_key') AND m.kind=json_extract(j.value,'$.kind') AND m.member_id=json_extract(j.value,'$.member_id')`).bind(stableJson(group),h.user_id,h.active_epoch))];
  const loaded=reads.length?await db.batch(reads):[];
  for(const result of loaded.slice(0,keyGroups.length))for(const r of result.results as {aggregate_key:string;payload:string}[])rows.set(r.aggregate_key,JSON.parse(r.payload));
  for(const result of loaded.slice(keyGroups.length))for(const m of result.results as Member[])previous.set(memberKey(m),m.refs);
  for(const d of deltas)for(const [event,sign] of [[d.before,-1],[d.after,1]] as const)if(event)for(const key of cloudMetricKeys(event)){
    let row=rows.get(key);if(!row){row=empty(key);rows.set(key,row);}row.events+=sign;if(row.events<0)throw Error('negative event count');
    for(const field of TOKEN_FIELDS)if(event[field]!==null){row.sums[field]=(BigInt(row.sums[field])+BigInt(event[field])*BigInt(sign)).toString();row.known[field]+=sign;if(row.known[field]<0||BigInt(row.sums[field])<0n)throw Error('negative metric contribution');}
  }
  for(const m of members){const old=previous.get(memberKey(m))||0,next=old+m.refs;if(next<0)throw Error('negative member reference');rows.get(m.aggregate_key)![m.kind==='thread'?'thread_count':'turn_count']+=Number(next>0)-Number(old>0);m.refs=next;}
  const out:D1PreparedStatement[]=[];
  for(const group of chunks(members.filter(m=>m.refs>0)))out.push(db.prepare(`INSERT INTO v3_aggregate_members(user_id,epoch,aggregate_key,kind,member_id,refs) SELECT ?,?,json_extract(value,'$.aggregate_key'),json_extract(value,'$.kind'),json_extract(value,'$.member_id'),json_extract(value,'$.refs') FROM json_each(?) WHERE true ON CONFLICT(user_id,epoch,aggregate_key,kind,member_id) DO UPDATE SET refs=excluded.refs`).bind(h.user_id,h.active_epoch,stableJson(group)));
  for(const group of chunks(members.filter(m=>m.refs===0)))out.push(db.prepare(`DELETE FROM v3_aggregate_members WHERE rowid IN(SELECT m.rowid FROM json_each(?) j CROSS JOIN v3_aggregate_members m WHERE m.user_id=? AND m.epoch=? AND m.aggregate_key=json_extract(j.value,'$.aggregate_key') AND m.kind=json_extract(j.value,'$.kind') AND m.member_id=json_extract(j.value,'$.member_id'))`).bind(stableJson(group),h.user_id,h.active_epoch));
  for(const group of chunks([...rows.values()].map(r=>({key:r.key,payload:stableJson(r)}))))out.push(db.prepare(`INSERT INTO v3_aggregates(user_id,epoch,aggregate_key,payload) SELECT ?,?,json_extract(value,'$.key'),json_extract(value,'$.payload') FROM json_each(?) WHERE true ON CONFLICT(user_id,epoch,aggregate_key) DO UPDATE SET payload=excluded.payload`).bind(h.user_id,h.active_epoch,stableJson(group)));
  return out;
}
