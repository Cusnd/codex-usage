import { HttpError } from "../../platform/worker/http.js";
import { applyBatch } from "../apply/apply.js";
import { decodeWire } from "../apply/codec.js";
import type { Job } from "./types.js";
import { advanceRebuild } from '../apply/rebuild.js';

export async function rebuildStep(db:D1Database,job:Job):Promise<boolean> {
  return advanceRebuild(db,job,async(_h,c)=>{const batchId=JSON.parse(job.payload).batch_id,row=await db.prepare('SELECT wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(job.user_id,batchId).first<{wire:ArrayBuffer}>();if(!row)throw new HttpError(409,'MISSING_PENDING_INPUT','待应用批次不存在。');return applyBatch(db,job.user_id,await decodeWire(new Uint8Array(row.wire)),job,c.epoch);});
}
