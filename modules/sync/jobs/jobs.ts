import { type UploadBatch } from "../../contracts/sync.js";
import { HttpError } from "../../platform/worker/http.js";
import { applyBatch } from "../apply/apply.js";
import { decodeWire } from "../apply/codec.js";
import { isCasFailure } from "../publication/store.js";
import { measured, type SyncTiming } from "../../foundation/timing.js";
import { originStep } from "./origin-handler.js";
import { queryBudget, QueryBudgetExhausted } from "./query-budget.js";
import { type Job } from "./types.js";
import { rebuildStep } from "./rebuild-handler.js";
import { claimJob, release } from './leases.js';
import { failJob, restartRebuild, recoverSupersededRebuild } from './recovery.js';
import { deleteDeviceStep } from './delete-handler.js';
import { dependencyStep } from './dependency-handler.js';

export async function advanceJobs(db:D1Database,options:{user?:string;job_id?:string;maxSteps?:number;maxQueries?:number;budgetMs?:number;knownBatch?:UploadBatch;timing?:SyncTiming}={}) {
  // The largest existing failure/restart path uses 15 statements. Keep that recovery
  // capacity plus a final lease release inside, rather than outside, maxQueries.
  const budget=options.maxQueries===undefined?undefined:queryBudget(db,options.maxQueries,16),releaseDb=budget?.releaseDb??db,recoveryDb=budget?.recoveryDb??db;
  db=budget?.db??db;
  const deadline=Date.now()+(options.budgetMs??5000);let processed=0,budgetExhausted=false;
  while(processed<(options.maxSteps??4)&&Date.now()<deadline){let job:Job|null=null;
    try {
    job=await measured(options.timing,'job_claim',()=>claimJob(db,options.user,options.job_id));if(!job)break;processed++;
    try {
      let done:boolean;
      if(job.kind==='apply'){const id=JSON.parse(job.payload).batch_id,known=options.knownBatch;let b:UploadBatch;if(options.user===job.user_id&&known&&known.batch_id===id)b=known;else{const user=job.user_id,row=await measured(options.timing,'pending_read',()=>db.prepare('SELECT wire FROM v3_pending_inputs WHERE user_id=? AND batch_id=?').bind(user,id).first<{wire:ArrayBuffer}>());if(!row){await failJob(db,job,'MISSING_PENDING_INPUT');continue;}b=await decodeWire(new Uint8Array(row.wire));}done=await applyBatch(db,job.user_id,b,job,undefined,options.timing);}
      else if(job.kind==='delete_device')done=await deleteDeviceStep(db,job);
      else if(job.kind==='dependency')done=await dependencyStep(db,job);
      else if(job.kind==='rebuild')done=await rebuildStep(db,job);
      else if(job.kind==='origin_assignment')done=await originStep(db,job);
      else {await failJob(db,job,'UNKNOWN_JOB');continue;}
      if(!done)await release(db,job,job.kind==='dependency'?30_000:500);
    }catch(error){
      if(error instanceof QueryBudgetExhausted)throw error;
      if(error instanceof HttpError){if(error.code==='DEVICE_PAUSED'){if(job.kind==='rebuild')await restartRebuild(recoveryDb,job);else await release(releaseDb,job,30_000,error.code);}else if(error.code==='REBUILD_SUPERSEDED'&&job.kind==='rebuild')await recoverSupersededRebuild(recoveryDb,job);else await failJob(recoveryDb,job,error.code,error.code==='DEVICE_REVOKED');}
      else if(isCasFailure(error))await release(releaseDb,job,250,'WRITE_CONFLICT');
      else {await release(releaseDb,job,Math.min(60_000,1000*2**Math.min(job.attempts,6)),'APPLY_FAILED');throw error;}
    }
    }catch(error){
      if(!(error instanceof QueryBudgetExhausted))throw error;
      budgetExhausted=true;
      // Checkpoints already committed remain authoritative. The token guard makes this
      // a no-op if the successful checkpoint already released or replaced our lease.
      if(job)await release(releaseDb,job,0);
      break;
    }
  }
  return {steps:processed,queries:budget?.stats.queries??null,budgetExhausted};
}

export type { Job } from './types.js';

export { claimJob } from './leases.js';
