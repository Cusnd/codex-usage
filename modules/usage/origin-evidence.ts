import { stableJson } from '../foundation/stable-json.js';
import { TOKEN_FIELDS,type Candidate } from './types.js';
import type { CandidateRow } from './candidate-row.js';

type Proof={observation_id:string;record_revision:number;collector_id:string;source_id:string;device_id:string;kind:'execution'|'local_append'|'preserved';value:string};
type EvidencedCandidate=Candidate&{origin_proofs?:Proof[];origin_record?:{prefix_hash:string;observed_local:boolean}};
const parse=(r:CandidateRow)=>JSON.parse(r.candidate) as EvidencedCandidate;
const valueKey=(c:Candidate)=>stableJson([c.event_id,c.thread_id,c.turn_id,c.at,...TOKEN_FIELDS.map(k=>c[k])]);
const proofKey=(p:Proof)=>stableJson([p.observation_id,p.record_revision,p.device_id,p.kind,p.value]);
const direct=(c:Candidate)=>!!c.origin.device_id&&['execution','local_append'].includes(c.origin.kind);
function ownProof(row:CandidateRow):Proof[]{
  const c=parse(row);
  if(!direct(c))return [];
  return [{observation_id:c.observation_id,record_revision:c.record_revision,collector_id:row.collector_id,source_id:row.source_id,device_id:c.origin.device_id!,kind:c.origin.kind as Proof['kind'],value:valueKey(c)}];
}

/** Only authenticated proof is copied. The uploader's preserved claim is never a proof. */
export function reconcileOriginEvidence(rows:CandidateRow[],before:CandidateRow[],preserveRemoved=false):CandidateRow[]{
  const active=rows.filter(r=>r.active),liveProofs=new Set(active.flatMap(ownProof).map(proofKey));
  const recovered=before.filter(old=>old.active&&active.some(row=>{
    const a=parse(old),b=parse(row);return old.collector_id===row.collector_id&&old.source_id===row.source_id&&old.generation!==row.generation&&b.origin_record?.observed_local&&!!a.origin_record?.prefix_hash&&a.origin_record.prefix_hash===b.origin_record.prefix_hash&&valueKey(a)===valueKey(b);
  }));
  const withdrawn=new Set<string>();
  if(!preserveRemoved)for(const old of before.filter(r=>r.active&&!recovered.includes(r))){
    const next=active.find(r=>r.observation_id===old.observation_id),c=parse(old);
    const changed=!next||next.record_revision!==old.record_revision||valueKey(parse(next))!==valueKey(c)||stableJson(parse(next).origin)!==stableJson(c.origin);
    if(changed)for(const p of [...ownProof(old),...(c.origin_proofs||[]).filter(p=>p.collector_id===old.collector_id&&p.source_id===old.source_id)])if(!liveProofs.has(proofKey(p)))withdrawn.add(proofKey(p));
  }
  const proofs=new Map<string,Proof>();
  for(const row of [...active,...recovered])for(const p of [...ownProof(row),...(parse(row).origin_proofs||[])])if(!withdrawn.has(proofKey(p)))proofs.set(proofKey(p),p);
  return rows.map(row=>{
    if(!row.active)return row;
    const c=parse(row),strong=c.identity_quality!=='source_position';
    const retained=[...proofs.values()].filter(p=>p.value===valueKey(c)&&(strong||p.observation_id===c.observation_id)).sort((a,b)=>proofKey(a).localeCompare(proofKey(b)));
    const devices=new Set(retained.map(p=>p.device_id)),origin=direct(c)?c.origin:{kind:devices.size===1?'preserved' as const:'unknown' as const,device_id:devices.size===1?[...devices][0]:null};
    const next: EvidencedCandidate={...c,origin,origin_proofs:retained};
    return {...row,candidate:stableJson(next)};
  });
}

/** Retain the original proof strength so a copied local append cannot outrank a conflict. */
export function candidatesWithOriginEvidence(row:CandidateRow):Candidate[]{
  const c=parse(row),proofs=c.origin_proofs;
  if(!proofs)return [c];
  if(!proofs.length)return [{...c,origin:direct(c)?c.origin:{kind:'unknown',device_id:null}}];
  return proofs.map(p=>({...c,origin:{kind:p.kind,device_id:p.device_id}}));
}
