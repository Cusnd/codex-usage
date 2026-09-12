import type { Store } from "../storage/sqlite.js";
import { type UploadBatch } from "../contracts/sync.js";

export function flushLocalBatches(store:Store,onBatch?: (batch:UploadBatch)=>void) {

    if(!onBatch)return;
    for(;;){const row=store.one('SELECT seq,raw_json FROM collector_batches WHERE local_applied=0 ORDER BY seq LIMIT 1');if(!row)return;
      const batch=JSON.parse(row.raw_json) as UploadBatch;
      store.transaction(()=>{onBatch!(batch);store.run('UPDATE collector_batches SET local_applied=1 WHERE seq=?',[row.seq]);store.run("DELETE FROM collector_batches WHERE seq=? AND (cloud_required=0 OR cloud_state='applied')",[row.seq]);});}

}
