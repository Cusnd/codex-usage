import { stableJson } from '../../contracts/sync.js';
import { canonicalize } from "../../usage/canonical.js";
import type { CanonicalEvent } from "../../usage/types.js";
import { sha256 } from "../../platform/worker/http.js";
import { candidatesWithOriginEvidence } from "../../usage/origin-evidence.js";
import { type CandidateRow } from '../../usage/candidate-row.js';

export const scopedProjectId=async(collector:string,id:string|null)=>id===null?null:'pc1:'+await sha256(stableJson([collector,id]));

export async function canonicalFromRows(rows:CandidateRow[]):Promise<CanonicalEvent|null>{const value=canonicalize(rows.flatMap(candidatesWithOriginEvidence));if(!value)return null;const selected=rows.find(r=>r.observation_id===value.selected_observation_id)!;return {...value,source_project_id:await scopedProjectId(selected.collector_id,value.source_project_id)};}
