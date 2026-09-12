import type {Store} from '../db.js';
import type {Collector} from '../collector/store.js';
import {V3_CONTENT_TYPE,stableJson,type UploadAck,type UploadBatch,type Lane} from '../../shared/sync-v3.js';
import {encodeUpload} from './codec.js';
import {sha256} from '../collector/projection.js';
import {legacyPreparations,queueLegacyReplacements} from './migration.js';

export type UploadCredentials={deviceId:string;token:string;origin:string};
type WireRow={batch_id:string;wire:Uint8Array;wire_hash:string;records_hash:string;attempts:number;next_at:number;status:string;error:string|null;ack_json:string|null};
type Options={fetch?:typeof fetch;now?:()=>number;random?:()=>number};
/** At most one live and one backfill request, with an applied barrier when a source changes lanes. */
export class V3Uploader {
  private active:Promise<void>|null=null;private stopped=false;private controller=new AbortController();private fetcher:typeof fetch;private now:()=>number;
  constructor(private store:Store,readonly collector:Collector,private options:Options={}) {
    this.fetcher=options.fetch||fetch;this.now=options.now||Date.now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS collector_wire(batch_id TEXT PRIMARY KEY,wire BLOB NOT NULL,wire_hash TEXT NOT NULL,records_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',error TEXT,ack_json TEXT);
      CREATE TABLE IF NOT EXISTS collector_upload_state(id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT,error TEXT,uploaded_at TEXT,received_seq_live INTEGER NOT NULL DEFAULT 0,applied_seq_live INTEGER NOT NULL DEFAULT 0,received_seq_backfill INTEGER NOT NULL DEFAULT 0,applied_seq_backfill INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO collector_upload_state(id) VALUES(1);`);
    store.db.exec("CREATE TABLE IF NOT EXISTS collector_status_report(id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT,hash TEXT,reported_at INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO collector_status_report(id) VALUES(1)");
  }
  status() {
    const state=this.store.one('SELECT * FROM collector_upload_state WHERE id=1')!;
    const pending=this.store.one("SELECT COUNT(DISTINCT source_id) n FROM collector_batches WHERE cloud_required=1 AND cloud_state<>'applied'")!;
    const next=this.store.one("SELECT MIN(next_at) n FROM collector_wire WHERE status IN ('pending','received')")?.n;
    const pendingThreads=Number(this.store.one("SELECT COUNT(DISTINCT s.thread_id) n FROM local_v3_sources s WHERE EXISTS(SELECT 1 FROM collector_batches b WHERE b.source_id=s.source_id AND b.cloud_required=1 AND b.cloud_state<>'applied')")?.n||0);
    return {enabled:!this.stopped,error:state.error,totalThreads:Number(this.store.one('SELECT COUNT(*) n FROM threads')!.n),pendingThreads,
      totalSources:Number(this.store.one('SELECT COUNT(*) n FROM collector_sources')!.n),pendingSources:Number(pending.n),
      pendingBatches:Number(this.store.one("SELECT COUNT(*) n FROM collector_batches WHERE cloud_required=1 AND cloud_state<>'applied'")!.n),receivedBatches:Number(this.store.one("SELECT COUNT(*) n FROM collector_batches WHERE cloud_required=1 AND cloud_state='received'")!.n),
      migrationPending:Number(this.store.one("SELECT COUNT(*) n FROM collector_legacy_replacements WHERE status<>'applied'")?.n||0),
      lastScanAt:this.store.one('SELECT MAX(updated_at) at FROM source_files')?.at??null,collectedAt:this.store.one('SELECT MAX(updated_at) at FROM source_files')?.at??null,
      uploadedAt:state.uploaded_at as string|null,nextUploadAt:next?new Date(Number(next)).toISOString():null,
      received:{live:Number(state.received_seq_live),backfill:Number(state.received_seq_backfill)},applied:{live:Number(state.applied_seq_live),backfill:Number(state.applied_seq_backfill)}};
  }
  tick(credentials:UploadCredentials,current:()=>boolean=()=>true):Promise<void> {
    if(this.active)return this.active;if(this.stopped||!current())return Promise.resolve();
    const operation=this.run(credentials,current).catch(()=>{if(current()&&!this.stopped)this.store.run("UPDATE collector_upload_state SET error='用量同步失败；待处理批次已保留，将在网络恢复后继续。' WHERE id=1");});
    this.active=operation;void operation.finally(()=>{this.active=null;});return operation;
  }
  private async run(credentials:UploadCredentials,current:()=>boolean) {
    const binding=this.collector.binding();
    if(binding.device_id!==credentials.deviceId){await this.collector.configureCloud(credentials.deviceId);this.store.transaction(()=>{this.store.run('DELETE FROM collector_wire');this.store.run('UPDATE collector_upload_state SET device_id=?,error=NULL,uploaded_at=NULL,received_seq_live=0,applied_seq_live=0,received_seq_backfill=0,applied_seq_backfill=0 WHERE id=1',[credentials.deviceId]);});
      void this.collector.scan().catch(()=>{});}
    if(!current()||this.stopped)return;
    const prepared=new Set<string>();if(!await this.prepareMigrations(credentials,current,prepared))return;
    const receipts=this.store.all<WireRow>("SELECT * FROM collector_wire WHERE status='received' AND next_at<=? ORDER BY next_at,batch_id LIMIT 16",[this.now()]);
    // A failed background receipt makes the route return an error for the entire request.
    // Query individual IDs so a terminal result cannot wrongly block the other lane.
    for(const wire of receipts) {
      if(!current()||this.stopped)return;
      try{
        const {response,data}=await this.request(credentials,'/api/v3/receipts?ids='+encodeURIComponent(wire.batch_id),'GET');
        if(!current()||this.stopped)return;
        if(response.ok){
          if(!Array.isArray(data.receipts)||data.receipts.length!==1||data.receipts[0]?.batch_id!==wire.batch_id)throw Error('INVALID_ACK');
          this.acknowledge(data.receipts[0]);
        }else if(!this.reject(wire,response,data,true))this.retry(wire,response);
      }catch{if(current()&&!this.stopped)this.retry(wire);}
    }
    queueLegacyReplacements(this.store,this.collector.id,credentials.deviceId,this.collector.binding().producer_epoch);
    await Promise.all((['live','backfill'] as const).map(lane=>this.drainLane(lane,credentials,current,prepared)));
    if(current()&&!this.stopped)await this.reportStatus(credentials);
  }
  private async prepareMigrations(credentials:UploadCredentials,current:()=>boolean,prepared:Set<string>):Promise<boolean> {
    for(const preparation of legacyPreparations(this.store,this.collector.id,credentials.deviceId)){
      const key=stableJson(preparation);if(prepared.has(key))continue;
      const {response,data}=await this.request(credentials,'/api/v3/legacy/prepare','POST',undefined,preparation);
      if(!current()||this.stopped)return false;
      if(response.status!==200||data.status!=='ready'){
        this.store.run("UPDATE collector_upload_state SET error=? WHERE id=1",[response.status===202?'旧历史仍可读取；正在准备一致的迁移版本。':'旧历史迁移准备尚未完成；上传队列已保留。']);return false;
      }
      prepared.add(key);
    }
    return true;
  }
  private async reportStatus(credentials:UploadCredentials){
    if(this.store.one("SELECT 1 FROM collector_wire WHERE status='blocked' LIMIT 1"))return;
    const scan=this.store.one('SELECT * FROM collector_scan_state WHERE id=1'),report=this.store.one('SELECT * FROM collector_status_report WHERE id=1')!;
    const status=this.status(),incomplete=this.store.one('SELECT 1 FROM collector_sources WHERE complete=0 OR reset_required=1 LIMIT 1');
    const body={collectedAt:scan?.completed_at??null,totalThreads:status.totalThreads,initialComplete:!!scan?.completed_at&&!scan.error_count&&!incomplete&&status.pendingBatches===0,error:scan?.error_count?'COLLECTION_FAILED':null};
    const hash=sha256(JSON.stringify(body));if(report.device_id===credentials.deviceId&&report.hash===hash&&this.now()-Number(report.reported_at)<15000)return;
    const {response}=await this.request(credentials,'/api/v3/sync/status','PUT',undefined,body);
    if(response.ok)this.store.run('UPDATE collector_status_report SET device_id=?,hash=?,reported_at=? WHERE id=1',[credentials.deviceId,hash,this.now()]);
  }
  private async prepare(batchId:string):Promise<WireRow> {
    const saved=this.store.db.prepare('SELECT * FROM collector_wire WHERE batch_id=?').get(batchId) as WireRow|undefined;
    if(saved){if(sha256(saved.wire)!==saved.wire_hash)throw Error('WIRE_CHECKSUM_MISMATCH');return saved;}
    const row=this.store.one('SELECT raw_json FROM collector_batches WHERE batch_id=?',[batchId]);if(!row)throw Error('MISSING_BATCH');
    const {wire,wire_hash,records_hash}=await encodeUpload(JSON.parse(row.raw_json));
    this.store.run('INSERT OR IGNORE INTO collector_wire(batch_id,wire,wire_hash,records_hash) VALUES(?,?,?,?)',[batchId,wire,wire_hash,records_hash]);
    return this.store.db.prepare('SELECT * FROM collector_wire WHERE batch_id=?').get(batchId) as WireRow;
  }
  private async drainLane(lane:Lane,credentials:UploadCredentials,current:()=>boolean,prepared:Set<string>) {
    const deadline=this.now()+1000;let sends=0;
    while(current()&&!this.stopped&&sends++<16&&this.now()<=deadline) {
      const row=this.store.one(`SELECT b.batch_id FROM collector_batches b LEFT JOIN collector_wire w ON w.batch_id=b.batch_id WHERE b.cloud_required=1 AND b.lane=? AND b.cloud_state='pending'
        AND (w.batch_id IS NULL OR w.status='pending' AND w.next_at<=?)
        AND NOT EXISTS(SELECT 1 FROM collector_batches earlier WHERE earlier.cloud_required=1 AND earlier.cloud_state<>'applied' AND earlier.seq<b.seq AND (earlier.lane=b.lane OR earlier.source_id=b.source_id)) ORDER BY b.lane_seq LIMIT 1`,[lane,this.now()]);
      if(!row)return;let wire:WireRow;
      try{wire=await this.prepare(row.batch_id);}catch(e:any){this.store.run('UPDATE collector_upload_state SET error=? WHERE id=1',[e.code==='RECORD_TOO_LARGE'?'必要记录超过当前上传契约；采集进度与原记录已保留。':'本机待发批次校验失败；未丢弃数据。']);return;}
      if(!current()||this.stopped)return;
      try{
        // scan/watch may enqueue a new generation while an earlier preparation is awaiting HTTP.
        // Re-read provenance after selecting immutable wire, before that exact packet can be sent.
        if(!await this.prepareMigrations(credentials,current,prepared))return;
        const {response,data}=await this.request(credentials,'/api/v3/ingest','POST',wire);
        if(!current()||this.stopped)return;
        if(response.ok){this.acknowledge(data);if(data.status==='received')return;continue;}
        if(this.reject(wire,response,data))return;
        this.retry(wire,response);return;
      }catch{if(current()&&!this.stopped)this.retry(wire);return;}
    }
  }
  private async request(credentials:UploadCredentials,route:string,method:string,wire?:WireRow,jsonBody?:unknown) {
    const response=await this.fetcher(credentials.origin+route,{method,headers:{Authorization:`Bearer ${credentials.token}`,...(wire?{'Content-Type':V3_CONTENT_TYPE,'X-Wire-SHA256':wire.wire_hash}:jsonBody?{'Content-Type':'application/json'}: {})},
      body:wire?new Uint8Array(wire.wire) as BodyInit:jsonBody?JSON.stringify(jsonBody):undefined,redirect:'error',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)])});
    const reader=response.body?.getReader();let length=0;const parts:Uint8Array[]=[];
    try{if(reader)for(;;){const value=await reader.read();if(value.done)break;length+=value.value.length;if(length>64*1024){await reader.cancel();throw Error('INVALID_RESPONSE');}parts.push(value.value);}}finally{reader?.releaseLock();}
    let data:Record<string,any>;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('INVALID_RESPONSE');}return {response,data};
  }
  private retry(wire:WireRow,response?:Response) {
    const attempts=Number(wire.attempts)+1,header=response?.headers.get('retry-after');const requested=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-this.now()):0;
    const delay=Math.max(Number.isFinite(requested)?requested:0,Math.min(900000,1000*2**Math.min(attempts-1,9))*(0.75+(this.options.random||Math.random)()/2));
    this.store.run('UPDATE collector_wire SET attempts=?,next_at=?,error=? WHERE batch_id=?',[attempts,this.now()+Math.max(250,delay),'NETWORK_RETRY',wire.batch_id]);
    this.store.run("UPDATE collector_upload_state SET error='用量同步暂时失败；本机统计仍可用，待处理批次已保留。' WHERE id=1");
  }
  private reject(wire:WireRow,response:Response,data:Record<string,any>,receipt=false):boolean {
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
    const handoffs=(JSON.parse(batch.raw_json) as UploadBatch).metadata.filter(m=>m.type==='legacy_replacement');
    if(ack.handoff_results!==undefined&&(!Array.isArray(ack.handoff_results)||ack.status!=='applied'||ack.handoff_results.length!==handoffs.length||ack.handoff_results.some(r=>!r||!['applied','superseded'].includes(r.status)||!handoffs.some(m=>m.dataset_id===r.dataset_id&&m.thread_id===r.thread_id))||new Set(ack.handoff_results.map(r=>stableJson([r.dataset_id,r.thread_id]))).size!==handoffs.length))throw Error('INVALID_ACK');
    const lane=batch.lane==='live'?'live':'backfill';
    this.store.transaction(()=>{
      this.store.run('UPDATE collector_wire SET status=?,error=NULL,ack_json=?,next_at=? WHERE batch_id=?',[ack.status,JSON.stringify(ack),this.now()+Math.max(250,ack.retry_after_ms||1000),ack.batch_id]);
      this.store.run('UPDATE collector_batches SET cloud_state=? WHERE batch_id=?',[ack.status,ack.batch_id]);
      this.store.run(`UPDATE collector_upload_state SET error=CASE WHEN EXISTS(SELECT 1 FROM collector_wire WHERE status='blocked') THEN error ELSE NULL END,uploaded_at=CASE WHEN ?='applied' THEN ? ELSE uploaded_at END,received_seq_${lane}=MAX(received_seq_${lane},?),applied_seq_${lane}=MAX(applied_seq_${lane},?) WHERE id=1`,[ack.status,new Date(this.now()).toISOString(),ack.contiguous_received_seq,ack.contiguous_applied_seq]);
      if(ack.status==='applied'){
        for(const m of handoffs){const result=ack.handoff_results?.find(r=>r.dataset_id===m.dataset_id&&r.thread_id===m.thread_id),same=m.sources.every(s=>Number(this.store.one('SELECT generation FROM collector_sources WHERE id=?',[s.source_id])?.generation)===s.generation),complete=result?.status!=='superseded'&&same;
          this.store.run('UPDATE collector_legacy_replacements SET status=?,batch_id=CASE WHEN ? THEN batch_id ELSE NULL END WHERE batch_id=? AND dataset_id=? AND thread_id=?',[complete?'applied':'waiting',Number(complete),ack.batch_id,m.dataset_id,m.thread_id]);}
        this.store.run('DELETE FROM collector_batches WHERE batch_id=? AND local_applied=1',[ack.batch_id]);this.store.run('DELETE FROM collector_wire WHERE batch_id=?',[ack.batch_id]);
      }
    });return true;
  }
  cancel() {this.controller.abort();this.controller=new AbortController();}
  async unbind() {this.cancel();if(this.active)await this.active;await this.collector.configureCloud(null);this.store.run('DELETE FROM collector_wire');}
  async close() {this.stopped=true;this.cancel();await this.active;}
}
