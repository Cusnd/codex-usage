import {mkdirSync,readFileSync,writeFileSync,watch,type FSWatcher} from 'node:fs';
import {readdir,stat,open,type FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Store} from '../db.js';
import {completeLines,type FramingMetrics} from './framing.js';
import {projectLine,sha256,nextChain,EMPTY_CHAIN} from './projection.js';
import {initialContext,nextContext} from '../../shared/usage-domain/normalize.js';
import {EXTRACTOR_VERSION,stableJson,V3_MAX_DECODED_BYTES,V3_TARGET_BYTES,type UploadBatch,type Lane,type SyncMetadata} from '../../shared/sync-v3.js';
import type {ExtractionContext,Observation,SourceKind,OriginEvidence} from '../../shared/usage-domain/types.js';

type SourceState={context:ExtractionContext;chain:string;trusted:boolean};
type Source={id:string;path:string;identity:string;kind:SourceKind;generation:number;version:number;offset:number;size:number;mtime:string;state:string;prefix_length:number;prefix_sha:string;tail_start:number;tail_sha:string;begun:number;complete:number;issues:number;available:number;caught_up:number;reset_required:number};
export type CollectionMetrics=FramingMetrics&{discovered:number;processed:number;unchanged:number;renamed:number;generations_started:number;selected_records:number;issues:number;batches:number;source_yields:number;check_bytes_read:number;audit_bytes_read:number;errors:{source_id:string|null;code:string}[];wall_ms:number};
type CollectorOptions={sourceRoot:string;stateRoot?:string;identityFile?:string|null;collectorId?:string;chunkBytes?:number;maxLineBytes?:number;maxBatchBytes?:number;maxBatchRecords?:number;checkpointBytes?:number;maxPassBytes?:number;
  onBatch?:(batch:UploadBatch)=>void;onCycle?:(metrics:CollectionMetrics)=>void;onError?:(error:unknown)=>void;
  resolveProject?:(cwd:string|null,threadId:string)=>Promise<{id:string|null;metadata?:SyncMetadata[]}>;
  origin?:(source:Source,locator:number)=>OriginEvidence;
  beforeCommit?:(batch:UploadBatch)=>void;afterCommit?:(batch:UploadBatch)=>void};
const metrics=():CollectionMetrics=>({bytes_read:0,max_line_bytes:0,trailing_bytes:0,discovered:0,processed:0,unchanged:0,renamed:0,generations_started:0,selected_records:0,issues:0,batches:0,source_yields:0,check_bytes_read:0,audit_bytes_read:0,errors:[],wall_ms:0});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const describe=(s:Awaited<ReturnType<FileHandle['stat']>>)=>({identity:`${s.dev}:${s.ino}:${s.birthtimeMs}`,size:Number(s.size),mtime:String(s.mtimeMs)});
const failure=(code:string)=>Object.assign(Error(code),{code});

/** One durable extraction stream; each consumer acknowledges in its own transaction in usage.sqlite. */
export class Collector {
  readonly id:string;readonly sourceRoot:string;
  private pending=new Map<string,{dirty:boolean;lane:Lane}>();private urgent=new Set<string>();private watchers:FSWatcher[]=[];
  private active:Promise<CollectionMetrics>|null=null;private timer:ReturnType<typeof setTimeout>|undefined;private reconcileTimer:ReturnType<typeof setInterval>|undefined;
  private closed=false;private watching=false;private needDiscovery=false;private options:Required<Pick<CollectorOptions,'chunkBytes'|'maxLineBytes'|'maxBatchBytes'|'maxBatchRecords'|'checkpointBytes'|'maxPassBytes'>>&CollectorOptions;
  constructor(readonly store:Store,options:CollectorOptions) {
    this.options={chunkBytes:256*1024,maxLineBytes:64*1024*1024,maxBatchBytes:V3_TARGET_BYTES-16384,maxBatchRecords:500,checkpointBytes:4*1024*1024,maxPassBytes:8*1024*1024,...options};
    this.sourceRoot=path.resolve(options.sourceRoot);
    const identityFile=options.identityFile===null?null:options.identityFile||options.stateRoot&&path.join(options.stateRoot,'collector-identity.json');
    if(identityFile){mkdirSync(path.dirname(identityFile),{recursive:true});try{writeFileSync(identityFile,JSON.stringify({version:1,collector_id:options.collectorId||randomUUID()}),{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
      const identity=JSON.parse(readFileSync(identityFile,'utf8'));if(identity.version!==1||typeof identity.collector_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(identity.collector_id))throw failure('COLLECTOR_IDENTITY_INVALID');this.id=identity.collector_id;
    }else {
      const hasBinding=store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_binding'");
      this.id=options.collectorId||(hasBinding?store.one('SELECT collector_id FROM collector_binding WHERE id=1')?.collector_id:null)||randomUUID();
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_binding(id INTEGER PRIMARY KEY CHECK(id=1),collector_id TEXT NOT NULL,source_root TEXT NOT NULL,device_id TEXT,producer_epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_sources(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,identity TEXT NOT NULL,kind TEXT NOT NULL,generation INTEGER NOT NULL,version INTEGER NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,mtime TEXT NOT NULL,state TEXT NOT NULL,prefix_length INTEGER NOT NULL,prefix_sha TEXT NOT NULL,tail_start INTEGER NOT NULL,tail_sha TEXT NOT NULL,begun INTEGER NOT NULL,complete INTEGER NOT NULL,issues INTEGER NOT NULL,available INTEGER NOT NULL,caught_up INTEGER NOT NULL,reset_required INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS collector_identity ON collector_sources(identity);
      CREATE TABLE IF NOT EXISTS collector_spans(source_id TEXT NOT NULL,generation INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(source_id,generation,start));
      CREATE TABLE IF NOT EXISTS collector_origin_proofs(source_id TEXT NOT NULL,prefix_hash TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(source_id,prefix_hash));
      CREATE TABLE IF NOT EXISTS collector_batches(seq INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT UNIQUE NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,lane TEXT NOT NULL,lane_seq INTEGER NOT NULL,raw_json TEXT NOT NULL,local_applied INTEGER NOT NULL DEFAULT 0,cloud_required INTEGER NOT NULL,cloud_state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collector_consumer ON collector_batches(local_applied,cloud_required,cloud_state,seq);
      CREATE TABLE IF NOT EXISTS collector_lane_sequences(lane TEXT PRIMARY KEY,next_seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO collector_lane_sequences VALUES('live',1),('backfill',1);
      CREATE TABLE IF NOT EXISTS collector_scan_state(id INTEGER PRIMARY KEY CHECK(id=1),completed_at TEXT,error_count INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO collector_scan_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS collector_extractor_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    `);
    const binding=store.one('SELECT * FROM collector_binding WHERE id=1');
    if(binding&&(binding.collector_id!==this.id||binding.source_root!==this.sourceRoot))throw failure('COLLECTOR_BINDING_MISMATCH');
    store.run('INSERT OR IGNORE INTO collector_binding VALUES(1,?,?,NULL,?)',[this.id,this.sourceRoot,randomUUID()]);
    const extractor=Number(store.one('SELECT version FROM collector_extractor_state WHERE id=1')?.version??1);
    if(extractor<EXTRACTOR_VERSION)store.transaction(()=>{
      // Re-read native logs through the normal atomic generation replacement. Keep
      // old pending wire bytes, source identities, and append witnesses untouched.
      store.run('UPDATE collector_sources SET reset_required=1,version=version+1');
      store.run('UPDATE collector_scan_state SET completed_at=NULL WHERE id=1');
      store.run('INSERT OR REPLACE INTO collector_extractor_state VALUES(1,?)',[EXTRACTOR_VERSION]);
    });
    else store.run('INSERT OR IGNORE INTO collector_extractor_state VALUES(1,?)',[EXTRACTOR_VERSION]);
  }
  private source(file:string):Source|undefined {return this.store.db.prepare('SELECT * FROM collector_sources WHERE path=?').get(file) as Source|undefined;}
  binding():{device_id:string|null;producer_epoch:string} {return this.store.one('SELECT device_id,producer_epoch FROM collector_binding WHERE id=1')!;}
  async configureCloud(deviceId:string|null) {
    if(this.active)await this.active;const old=this.binding();if(old.device_id===deviceId)return;
    this.store.transaction(()=>{
      this.store.run('UPDATE collector_binding SET device_id=?,producer_epoch=? WHERE id=1',[deviceId,randomUUID()]);
      // Old binding bytes cannot be uploaded under another credential; native logs provide the new baseline.
      this.store.run('UPDATE collector_batches SET cloud_required=0');this.store.run('DELETE FROM collector_batches WHERE local_applied=1');
      this.store.run('UPDATE collector_lane_sequences SET next_seq=1');
      if(deviceId){this.store.run('UPDATE collector_sources SET reset_required=1,version=version+1');this.store.run('UPDATE collector_scan_state SET completed_at=NULL WHERE id=1');}
    });
    this.needDiscovery=true;this.schedule();
  }
  accepts(file:string) {const relative=path.relative(this.sourceRoot,file);return relative==='session_index.jsonl'||/^(sessions|archived_sessions)[\\/]/.test(relative)&&relative.endsWith('.jsonl')&&!relative.split(/[\\/]/).includes('..');}
  notify(file:string,urgent=true) {
    if(this.closed)return;file=path.resolve(file);if(!this.accepts(file))return;
    const current=this.pending.get(file);if(current)current.dirty=true;else this.pending.set(file,{dirty:false,lane:urgent?'live':'backfill'});
    if(urgent)this.urgent.add(file);this.schedule();
  }
  enqueueMetadata(metadata:SyncMetadata[]) {
    if(!metadata.length)return;
    for(let start=0;start<metadata.length;start+=100){const selected=metadata.slice(start,start+100),binding=this.binding();
      this.store.transaction(()=>{const laneSeq=Number(this.store.one("SELECT next_seq FROM collector_lane_sequences WHERE lane='live'")!.next_seq);
        const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:EXTRACTOR_VERSION,collector_id:this.id,producer_epoch:binding.producer_epoch,lane:'live',lane_seq:laneSeq,batch_id:randomUUID(),records_hash:sha256(stableJson([])),sources:[],records:[],metadata:selected};
        const raw=stableJson(batch);if(Buffer.byteLength(raw)>V3_MAX_DECODED_BYTES)throw failure('RECORD_TOO_LARGE');
        this.store.run("INSERT INTO collector_batches(batch_id,source_id,generation,lane,lane_seq,raw_json,cloud_required,created_at) VALUES(?,'metadata',1,'live',?,?,?,?)",[batch.batch_id,laneSeq,raw,binding.device_id?1:0,new Date().toISOString()]);
        this.store.run("UPDATE collector_lane_sequences SET next_seq=next_seq+1 WHERE lane='live'");});
    }
    this.flushLocal();
  }
  private availability(row:Source,available:boolean,m:CollectionMetrics) {
    if(!!row.available===available)return;
    row={...row,generation:Number(row.generation),offset:Number(row.offset),size:Number(row.size)};
    const state=JSON.parse(row.state) as Partial<SourceState>,binding=this.binding();
    this.store.transaction(()=>{
      this.store.run('UPDATE collector_sources SET available=?,version=version+1 WHERE id=?',[available?1:0,row.id]);
      // A pending baseline has not established this cursor in the new binding yet.
      if(!row.begun||row.reset_required||!state.context)return;
      const lane='live',laneSeq=Number(this.store.one('SELECT next_seq FROM collector_lane_sequences WHERE lane=?',[lane])!.next_seq);
      const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:EXTRACTOR_VERSION,collector_id:this.id,producer_epoch:binding.producer_epoch,lane,lane_seq:laneSeq,batch_id:randomUUID(),records_hash:sha256(stableJson([])),
        sources:[{source_id:row.id,generation:row.generation,kind:row.kind,from_cursor:row.offset,to_cursor:row.offset,snapshot_eof:row.size,context_hash:sha256(stableJson(state.context)),context:state.context,
          replace_start:false,replace_end:false,generation_complete:!!row.complete,available,trailing_bytes:row.complete?row.size-row.offset:0}],records:[],metadata:[]};
      this.store.run('INSERT INTO collector_batches(batch_id,source_id,generation,lane,lane_seq,raw_json,cloud_required,created_at) VALUES(?,?,?,?,?,?,?,?)',[batch.batch_id,row.id,row.generation,lane,laneSeq,stableJson(batch),binding.device_id?1:0,new Date().toISOString()]);
      this.store.run('UPDATE collector_lane_sequences SET next_seq=next_seq+1 WHERE lane=?',[lane]);m.batches++;
    });
    this.flushLocal();
  }
  private async discover(m:CollectionMetrics) {
    const files:{file:string;priority:number}[]=[];
    const visit=async(dir:string)=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}
      for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&file.endsWith('.jsonl')){try{files.push({file,priority:(await stat(file)).mtimeMs});}catch(e:any){if(e.code!=='ENOENT')throw e;}}}};
    await visit(path.join(this.sourceRoot,'sessions'));await visit(path.join(this.sourceRoot,'archived_sessions'));
    const title=path.join(this.sourceRoot,'session_index.jsonl');try{files.push({file:title,priority:(await stat(title)).mtimeMs});}catch(e:any){if(e.code!=='ENOENT')throw e;}
    const present=new Set(files.map(f=>f.file));
    for(const row of this.store.all('SELECT * FROM collector_sources WHERE available=1') as Source[])if(!present.has(row.path))this.availability(row,false,m);
    for(const {file} of files.sort((a,b)=>b.priority-a.priority||a.file.localeCompare(b.file)))this.notify(file,false);m.discovered=files.length;
  }
  async scan(options:{audit?:boolean}={}):Promise<CollectionMetrics> {return this.run(true,!!options.audit);}
  async drain():Promise<CollectionMetrics> {return this.run(false,false);}
  private run(discover:boolean,audit:boolean):Promise<CollectionMetrics> {
    if(this.active)return this.active;const m=metrics(),started=performance.now();
    const work=(async()=>{if(discover)await this.discover(m);let turns=0;this.flushLocal();
      while(this.pending.size&&!this.closed){const useUrgent=this.urgent.size&&turns++%4!==3;const file=(useUrgent?this.urgent.values().next().value:this.pending.keys().next().value)!;
        this.urgent.delete(file);const task=this.pending.get(file);if(!task)continue;task.dirty=false;
        try{await this.processFile(file,m,audit,task.lane);}catch(e:any){m.errors.push({source_id:this.source(file)?.id??null,code:typeof e.code==='string'?e.code:'COLLECTION_FAILED'});task.dirty=false;}
        if(!task.dirty)this.pending.delete(file);await tick();}
      this.flushLocal();m.wall_ms=performance.now()-started;if(discover&&!this.closed)this.store.run('UPDATE collector_scan_state SET completed_at=?,error_count=? WHERE id=1',[new Date().toISOString(),m.errors.length]);this.options.onCycle?.(m);return m;})();
    this.active=work;void work.finally(()=>{this.active=null;if(this.pending.size||this.needDiscovery)this.schedule();}).catch(e=>this.options.onError?.(e));return work;
  }
  flushLocal() {
    if(!this.options.onBatch)return;
    for(;;){const row=this.store.one('SELECT seq,raw_json FROM collector_batches WHERE local_applied=0 ORDER BY seq LIMIT 1');if(!row)return;
      const batch=JSON.parse(row.raw_json) as UploadBatch;
      this.store.transaction(()=>{this.options.onBatch!(batch);this.store.run('UPDATE collector_batches SET local_applied=1 WHERE seq=?',[row.seq]);this.store.run("DELETE FROM collector_batches WHERE seq=? AND (cloud_required=0 OR cloud_state='applied')",[row.seq]);});}
  }
  private async spanHash(handle:FileHandle,start:number,end:number,m:CollectionMetrics,field:'check_bytes_read'|'audit_bytes_read') {
    const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(this.options.chunkBytes,Math.max(1,end-start)));
    for(let p=start;p<end;){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,end-p),p);if(!bytesRead)throw failure('SOURCE_CHANGED');hash.update(buffer.subarray(0,bytesRead));p+=bytesRead;m[field]+=bytesRead;}return hash.digest('hex');
  }
  private async processFile(file:string,m:CollectionMetrics,audit:boolean,lane:Lane) {
    m.processed++;let info:ReturnType<typeof describe>;try{info=describe(await stat(file));}catch(e:any){if(e.code!=='ENOENT')throw e;const old=this.source(file);if(old)this.availability(old,false,m);return;}
    let row=this.source(file);if(row&&!row.reset_required&&row.identity===info.identity&&row.size===info.size&&row.mtime===info.mtime&&row.caught_up&&!audit){if(!row.available)this.availability(row,true,m);m.unchanged++;return;}
    const handle=await open(file,'r');try {
      info=describe(await handle.stat());
      if(!row){const old=this.store.db.prepare('SELECT * FROM collector_sources WHERE identity=?').get(info.identity) as Source|undefined;if(old){this.store.run('UPDATE collector_sources SET path=?,available=1 WHERE id=?',[file,old.id]);row=this.source(file);m.renamed++;}}
      const kind=path.basename(file)==='session_index.jsonl'?'titles':'session';
      let reset=!!row&&(!!row.reset_required||row.identity!==info.identity||info.size<row.offset||info.size<=row.size&&info.mtime!==row.mtime);
      if(row&&!reset&&row.offset){reset=await this.spanHash(handle,0,row.prefix_length,m,'check_bytes_read')!==row.prefix_sha||await this.spanHash(handle,row.tail_start,row.offset,m,'check_bytes_read')!==row.tail_sha;
        if(!reset&&audit){let end=0;for(const span of this.store.db.prepare('SELECT * FROM collector_spans WHERE source_id=? AND generation=? ORDER BY start').all(row.id,row.generation) as {start:number;end:number;sha256:string}[]){if(span.start!==end||await this.spanHash(handle,span.start,span.end,m,'audit_bytes_read')!==span.sha256){reset=true;break;}end=span.end;}if(end!==row.offset)reset=true;}}
      if(!row){this.store.run(`INSERT INTO collector_sources VALUES(?,?,?,?,1,0,0,?,?,?,0,?,0,?,0,0,0,1,0,0)`,[randomUUID(),file,info.identity,kind,info.size,info.mtime,'{}',sha256(''),sha256('')]);row=this.source(file)!;m.generations_started++;}
      else if(reset){this.store.run(`UPDATE collector_sources SET identity=?,kind=?,generation=generation+1,version=version+1,offset=0,size=?,mtime=?,state='{}',prefix_length=0,prefix_sha=?,tail_start=0,tail_sha=?,begun=0,complete=0,issues=0,available=1,caught_up=0,reset_required=0 WHERE id=?`,[info.identity,kind,info.size,info.mtime,sha256(''),sha256(''),row.id]);row=this.source(file)!;m.generations_started++;}
      const fallback=path.basename(file).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
      const saved=JSON.parse(row.state);let state:SourceState=saved.context?saved:{context:initialContext(fallback||row.id),chain:EMPTY_CHAIN,trusted:!!fallback};
      let records:Observation[]=[],metadata:SyncMetadata[]=[],bytes=0,offset=row.offset,spanStart=offset,digest=createHash('sha256'),issues=row.issues;const passStart=offset;
      const flush=async(final:boolean)=>{
        if(!final&&offset===spanStart&&!records.length)return;
        const prefixLength=Math.min(offset,4096),tailStart=Math.max(0,offset-4096),prefix=await this.spanHash(handle,0,prefixLength,m,'check_bytes_read'),tail=await this.spanHash(handle,tailStart,offset,m,'check_bytes_read');
        const binding=this.binding(),laneSeq=Number(this.store.one('SELECT next_seq FROM collector_lane_sequences WHERE lane=?',[lane])!.next_seq);
        const batch:UploadBatch={protocol:3,schema_version:1,extractor_version:EXTRACTOR_VERSION,collector_id:this.id,producer_epoch:binding.producer_epoch,lane,lane_seq:laneSeq,batch_id:randomUUID(),records_hash:sha256(stableJson(records)),
          sources:[{source_id:row!.id,generation:row!.generation,kind,from_cursor:spanStart,to_cursor:offset,snapshot_eof:info.size,context_hash:sha256(stableJson(state.context)),context:state.context,
            replace_start:!row!.begun,replace_end:final&&!row!.complete,generation_complete:final,available:true,trailing_bytes:final?info.size-offset:0}],records,metadata};
        const raw=stableJson(batch);if(Buffer.byteLength(raw)>V3_MAX_DECODED_BYTES)throw failure('RECORD_TOO_LARGE');this.options.beforeCommit?.(batch);
        const spanSha=digest.copy().digest('hex');
        this.store.transaction(()=>{
          const result=this.store.run(`UPDATE collector_sources SET version=version+1,offset=?,size=?,mtime=?,state=?,prefix_length=?,prefix_sha=?,tail_start=?,tail_sha=?,begun=1,complete=?,issues=?,available=1,caught_up=? WHERE id=? AND version=?`,
            [offset,info.size,info.mtime,JSON.stringify(state),prefixLength,prefix,tailStart,tail,final?1:row!.complete,issues,final?1:0,row!.id,row!.version]);if(Number(result.changes)!==1)throw failure('CURSOR_CONFLICT');
          this.store.run('INSERT INTO collector_batches(batch_id,source_id,generation,lane,lane_seq,raw_json,cloud_required,created_at) VALUES(?,?,?,?,?,?,?,?)',[batch.batch_id,row!.id,row!.generation,lane,laneSeq,raw,binding.device_id?1:0,new Date().toISOString()]);
          for(const record of records)if(record.origin.kind==='local_append'&&record.origin.device_id)this.store.run('INSERT OR IGNORE INTO collector_origin_proofs VALUES(?,?,?)',[record.source_id,record.prefix_hash,record.origin.device_id]);
          this.store.run('UPDATE collector_lane_sequences SET next_seq=next_seq+1 WHERE lane=?',[lane]);
          if(offset>spanStart)this.store.run('INSERT INTO collector_spans VALUES(?,?,?,?,?)',[row!.id,row!.generation,spanStart,offset,spanSha]);
          if(final)this.store.run('DELETE FROM collector_spans WHERE source_id=? AND generation<>?',[row!.id,row!.generation]);
        });
        m.batches++;row=this.source(file)!;records=[];metadata=[];bytes=0;spanStart=offset;digest=createHash('sha256');this.options.afterCommit?.(batch);this.flushLocal();await tick();
      };
      const decoder=new TextDecoder('utf-8',{fatal:true});
      for await(const frame of completeLines(file,row.offset,info.size,{...this.options,metrics:m,handle})) {
        if(this.closed)break;let projected:ReturnType<typeof projectLine>;
        try{projected=projectLine(decoder.decode(frame.bytes),kind);}catch{projected={issue:'malformed-json-or-utf8'};}
        let next:SourceState={...state,chain:nextChain(state.chain,frame.bytes)},entry:Observation|undefined,newMetadata:SyncMetadata[]=[];
        if(projected.record){next.context=nextContext(state.context,projected.record);
          if(projected.record.type==='session_meta'&&(typeof projected.record.payload.id==='string'||typeof projected.record.payload.session_id==='string'))next.trusted=true;
          if(this.options.resolveProject&&(next.context.cwd!==state.context.cwd||!next.context.source_project_id)){const project=await this.options.resolveProject(next.context.cwd,next.context.thread_id);next.context={...next.context,source_project_id:project.id};newMetadata=project.metadata||[];}
        }
        if(projected.record||projected.issue){const device=this.binding().device_id;
          // A rebind/rescan changes observation IDs, but an identical raw prefix retains
          // the original append proof. Rewrites and a different binding cannot invent one.
          const proof=this.store.one('SELECT device_id FROM collector_origin_proofs WHERE source_id=? AND prefix_hash=?',[row.id,next.chain]);
          entry={observation_id:sha256(stableJson([this.id,row.id,row.generation,frame.start])),record_revision:1,source_id:row.id,generation:row.generation,locator:frame.start,byte_end:frame.end,prefix_hash:next.chain,session_trusted:next.trusted,
            origin:this.options.origin?.(row,frame.start)??(proof?{device_id:proof.device_id,kind:proof.device_id===device?'local_append':'preserved'}:{device_id:device,kind:device?(row.complete?'local_append':'observed_local'):'unknown'}),context:next.context,record:projected.record??null,...(projected.issue?{issue:projected.issue}:{})};}
        const size=entry?Buffer.byteLength(stableJson(entry))+Buffer.byteLength(stableJson(newMetadata)):0;
        if(size>V3_MAX_DECODED_BYTES-16384)throw failure('RECORD_TOO_LARGE');if(entry&&records.length&&(bytes+size>this.options.maxBatchBytes||records.length>=this.options.maxBatchRecords))await flush(false);
        state=next;if(projected.issue){issues++;m.issues++;}if(entry){records.push(entry);metadata.push(...newMetadata);bytes+=size;m.selected_records++;}
        offset=frame.end;digest.update(frame.bytes);
        if(bytes>=this.options.maxBatchBytes||records.length>=this.options.maxBatchRecords||offset-spanStart>=this.options.checkpointBytes)await flush(false);
        if(offset-passStart>=this.options.maxPassBytes&&offset<info.size){await flush(false);const task=this.pending.get(file)!;task.dirty=true;this.pending.delete(file);this.pending.set(file,task);m.source_yields++;return;}
      }
      await flush(!this.closed);
    } finally {await handle.close();}
  }
  private schedule() {
    if(!this.watching||this.closed||this.timer||this.active)return;
    this.timer=setTimeout(()=>{this.timer=undefined;const discovery=this.needDiscovery;this.needDiscovery=false;void this.run(discovery,false).catch(e=>this.options.onError?.(e));},25);this.timer.unref();
  }
  startWatching(reconcileMs=30000) {
    if(this.watching||this.closed)return;this.watching=true;
    const add=(dir:string,recursive:boolean)=>{try{const watcher=watch(dir,{recursive},(_event,name)=>{if(!name)this.needDiscovery=true;else {const file=path.join(dir,String(name));if(this.accepts(file))this.notify(file);else this.needDiscovery=true;}this.schedule();});watcher.on('error',e=>{this.needDiscovery=true;this.options.onError?.(e);this.schedule();});this.watchers.push(watcher);}catch(e:any){if(e.code!=='ENOENT')this.options.onError?.(e);}};
    add(this.sourceRoot,false);add(path.join(this.sourceRoot,'sessions'),true);add(path.join(this.sourceRoot,'archived_sessions'),true);
    this.reconcileTimer=setInterval(()=>{this.needDiscovery=true;this.schedule();},reconcileMs);this.reconcileTimer.unref();this.needDiscovery=true;this.schedule();
  }
  stopWatching() {this.watching=false;clearTimeout(this.timer);this.timer=undefined;clearInterval(this.reconcileTimer);this.reconcileTimer=undefined;for(const watcher of this.watchers)watcher.close();this.watchers=[];}
  async close() {this.closed=true;this.stopWatching();await this.active;}
}
