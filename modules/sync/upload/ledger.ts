import type { Store } from "../../storage/sqlite.js";
import { type UploadAck } from "../../contracts/sync.js";
import { encodeUpload } from "./codec.js";
import { sha256 } from "../../collection/projection.js";
import { type Options } from './types.js';

export type WireRow = {
    batch_id: string;
    wire: Uint8Array;
    wire_hash: string;
    records_hash: string;
    attempts: number;
    next_at: number;
    status: string;
    error: string | null;
    ack_json: string | null;
};

export class UploadLedger {
constructor(private store:Store,private now:()=>number,private options:Options) {}
async prepare(batchId:string):Promise<WireRow> {
    const saved=this.store.db.prepare('SELECT * FROM collector_wire WHERE batch_id=?').get(batchId) as WireRow|undefined;
    if(saved){if(sha256(saved.wire)!==saved.wire_hash)throw Error('WIRE_CHECKSUM_MISMATCH');return saved;}
    const row=this.store.one('SELECT raw_json FROM collector_batches WHERE batch_id=?',[batchId]);if(!row)throw Error('MISSING_BATCH');
    const {wire,wire_hash,records_hash}=await encodeUpload(JSON.parse(row.raw_json));
    this.store.run('INSERT OR IGNORE INTO collector_wire(batch_id,wire,wire_hash,records_hash) VALUES(?,?,?,?)',[batchId,wire,wire_hash,records_hash]);
    return this.store.db.prepare('SELECT * FROM collector_wire WHERE batch_id=?').get(batchId) as WireRow;
  }
retry(wire:WireRow,response?:Response) {
    const attempts=Number(wire.attempts)+1,header=response?.headers.get('retry-after');const requested=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-this.now()):0;
    const delay=Math.max(Number.isFinite(requested)?requested:0,Math.min(900000,1000*2**Math.min(attempts-1,9))*(0.75+(this.options.random||Math.random)()/2));
    this.store.run('UPDATE collector_wire SET attempts=?,next_at=?,error=? WHERE batch_id=?',[attempts,this.now()+Math.max(250,delay),'NETWORK_RETRY',wire.batch_id]);
    this.store.run("UPDATE collector_upload_state SET error='用量同步暂时失败；本机统计仍可用，待处理批次已保留。' WHERE id=1");
  }
reject(wire:WireRow,response:Response,data:Record<string,any>,receipt=false):boolean {
    if(![400,401,403,404,409,410,413,422].includes(response.status))return false;
    const code=typeof data.error?.code==='string'?data.error.code:receipt?'RECEIPT_REJECTED':'UPLOAD_REJECTED';
    this.store.transaction(()=>{
      this.store.run("UPDATE collector_wire SET status='blocked',error=? WHERE batch_id=?",[code,wire.batch_id]);
      this.store.run('UPDATE collector_upload_state SET error=? WHERE id=1',[response.status===401||response.status===410?'设备已撤销或替换，请重新绑定。':receipt?'云端未能应用已接收批次；本机数据和原始上传包已保留，请重新连接云端以重建同步基线。':'上传契约或身份冲突；来源已暂停，待处理数据已保留。']);
    });return true;
  }
acknowledge(input:unknown) {
    const ack=input as UploadAck;if(!ack||typeof ack.batch_id!=='string'||!['received','applied'].includes(ack.status))throw Error('INVALID_ACK');
    const wire=this.store.one('SELECT * FROM collector_wire WHERE batch_id=?',[ack.batch_id]),batch=this.store.one('SELECT lane,raw_json FROM collector_batches WHERE batch_id=?',[ack.batch_id]);
    if(!wire||!batch)return false;
    if(ack.wire_hash!==wire.wire_hash||ack.records_hash!==wire.records_hash||!Number.isSafeInteger(ack.contiguous_received_seq)||!Number.isSafeInteger(ack.contiguous_applied_seq)||
      ack.contiguous_applied_seq<0||ack.contiguous_received_seq<ack.contiguous_applied_seq||ack.status==='applied'&&!Number.isSafeInteger(ack.applied_commit_seq))throw Error('INVALID_ACK');
    const lane=batch.lane==='live'?'live':'backfill';
    this.store.transaction(()=>{
      this.store.run('UPDATE collector_wire SET status=?,error=NULL,ack_json=?,next_at=? WHERE batch_id=?',[ack.status,JSON.stringify(ack),this.now()+Math.max(250,ack.retry_after_ms||1000),ack.batch_id]);
      this.store.run('UPDATE collector_batches SET cloud_state=? WHERE batch_id=?',[ack.status,ack.batch_id]);
      this.store.run(`UPDATE collector_upload_state SET error=CASE WHEN EXISTS(SELECT 1 FROM collector_wire WHERE status='blocked') THEN error ELSE NULL END,uploaded_at=CASE WHEN ?='applied' THEN ? ELSE uploaded_at END,received_seq_${lane}=MAX(received_seq_${lane},?),applied_seq_${lane}=MAX(applied_seq_${lane},?) WHERE id=1`,[ack.status,new Date(this.now()).toISOString(),ack.contiguous_received_seq,ack.contiguous_applied_seq]);
      if(ack.status==='applied'){
        this.store.run('DELETE FROM collector_batches WHERE batch_id=? AND local_applied=1',[ack.batch_id]);this.store.run('DELETE FROM collector_wire WHERE batch_id=?',[ack.batch_id]);
      }
    });return true;
  }
}
