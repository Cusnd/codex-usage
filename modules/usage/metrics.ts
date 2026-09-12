import { stableJson } from '../foundation/stable-json.js';
import { TOKEN_FIELDS, type TokenField, type EventDelta, type CanonicalEvent } from './types.js';
export type MetricRow={key:string;events:number;sums:Record<TokenField,string>;known:Record<TokenField,number>;threads:Record<string,number>;turns:Record<string,number>};
export function emptyMetric(key:string):MetricRow {
  return {key,events:0,sums:Object.fromEntries(TOKEN_FIELDS.map(k=>[k,'0'])) as MetricRow['sums'],known:Object.fromEntries(TOKEN_FIELDS.map(k=>[k,0])) as MetricRow['known'],threads:{},turns:{}};
}
export function metricKeys(event:CanonicalEvent):string[] {
  return [['all'],['day',event.at.slice(0,10)],['thread',event.thread_id],['device',event.origin_device_id],['project',event.source_project_id],['model',event.model]].map(stableJson);
}
const ref=(counts:Record<string,number>,id:string,sign:number)=>{const n=(counts[id]||0)+sign;if(n<0)throw Error('negative membership count');if(n)counts[id]=n;else delete counts[id];};
/** BigInt sums with known-value and member references; null and zero remain distinct after deletion. */
export function applyMetricDeltas(rows:Map<string,MetricRow>,deltas:EventDelta[]):Map<string,MetricRow> {
  const touched=new Map<string,MetricRow>();
  for(const delta of deltas)for(const [event,sign] of [[delta.before,-1],[delta.after,1]] as const)if(event)for(const key of metricKeys(event)) {
    let row=rows.get(key);if(!row){row=emptyMetric(key);rows.set(key,row);}row.events+=sign;
    if(row.events<0)throw Error('negative event count');
    for(const k of TOKEN_FIELDS)if(event[k]!==null){row.sums[k]=(BigInt(row.sums[k])+BigInt(event[k])*BigInt(sign)).toString();row.known[k]+=sign;if(row.known[k]<0||BigInt(row.sums[k])<0n)throw Error('negative token contribution');}
    ref(row.threads,event.thread_id,sign);if(event.turn_id!==null)ref(row.turns,stableJson([event.thread_id,event.turn_id]),sign);touched.set(key,row);
  }
  return touched;
}
export const exactTotal=(row:MetricRow,field:TokenField):string|null=>row.known[field]?row.sums[field]:null;
