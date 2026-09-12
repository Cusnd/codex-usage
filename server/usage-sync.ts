import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import type { LimitObservation } from './refresh.js';
import { cloudSnapshot } from './cloud-sync.js';
import { SYNC_BODY_BYTES, SYNC_CHUNK_EVENTS, USAGE_PARSER_VERSION, validChunk, type SyncEvent, type SyncManifest, type SyncThread, type CloudAccountSnapshot } from '../shared/usage-sync.js';
import type { AccountUsage } from '../shared/contracts.js';

type Transport=(route:string,method:string,body?:unknown)=>Promise<{response:Response;data:Record<string,any>}>;
type State={datasetId:string;deviceId:string|null;scannedAt:number;nextAt:number;failures:number;error:string|null;total:number;accountSequence:number;accountHash:string|null;accountNextAt:number;uploadedAt?:string|null;collectedAt?:string|null;initialComplete?:boolean};
type Pending={id:string;revision:number;hash:string;payload:string|null;chunk:number};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export class UsageSync {
  private state:State;
  constructor(private store:Store,private transport:Transport,private observe:()=>Promise<LimitObservation>,
    private history?:()=>Promise<{data:AccountUsage|null;collectedAt:string|null;identityKey:string|null}>,private now:()=>number=Date.now,
    private collection?:()=>{running:boolean;updatedAt:string|null;error:string|null}) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS usage_sync_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_sync_outbox(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT,chunk INTEGER NOT NULL DEFAULT 0);`);
    const saved=store.one('SELECT value FROM usage_sync_state WHERE id=1');
    this.state=saved?JSON.parse(saved.value):{datasetId:randomUUID(),deviceId:null,scannedAt:0,nextAt:0,failures:0,error:null,total:0,accountSequence:0,accountHash:null,accountNextAt:0};
  }
  status(){return {enabled:true,error:this.state.error,totalThreads:this.state.total,pendingThreads:Number(this.store.one('SELECT COUNT(*) n FROM usage_sync_outbox WHERE payload IS NOT NULL')!.n),lastScanAt:this.state.scannedAt?new Date(this.state.scannedAt).toISOString():null,
    uploadedAt:this.state.uploadedAt||null,collectedAt:this.state.collectedAt||null,nextUploadAt:this.state.nextAt?new Date(this.state.nextAt).toISOString():null};}
  private save(){this.store.run('INSERT INTO usage_sync_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',[JSON.stringify(this.state)]);}
  refreshAccounts(){
    this.state.accountNextAt=0;
    // An explicit resume bypasses the ordinary polling interval, not failure/Retry-After backoff.
    if(!this.state.failures)this.state.nextAt=0;
    this.save();
  }
  private scan(){
    const threads=this.store.all('SELECT * FROM threads ORDER BY id');
    for(const row of threads){
      const thread:SyncThread={id:row.id,title:row.title??null,titleUpdatedAt:row.title_updated_at??null,project:row.project??null,source:row.source??null,
        parentId:row.parent_id??null,subagentParentId:row.subagent_parent_id??null,forkedFromId:row.forked_from_id??null};
      const events:SyncEvent[]=this.store.all('SELECT * FROM effective_events WHERE thread_id=? ORDER BY event_key',[row.id]).map(e=>({
        event_key:e.event_key,thread_id:e.thread_id,turn_id:e.turn_id,response_id:e.response_id,at:e.at,project:e.project,model:e.model,effort:e.effort,kind:e.kind,incomplete:Number(e.incomplete),
        input_tokens:e.input_tokens?.toString()??null,cached_input_tokens:e.cached_input_tokens?.toString()??null,cache_write_input_tokens:e.cache_write_input_tokens?.toString()??null,
        output_tokens:e.output_tokens?.toString()??null,reasoning_output_tokens:e.reasoning_output_tokens?.toString()??null,total_tokens:e.total_tokens?.toString()??null,
      }));
      // Size UTF-8 bytes as well as event count; full paths can make a small event list large.
      const chunks:SyncEvent[][]=[[]],overhead=Buffer.byteLength(JSON.stringify(thread))+2048;let bytes=overhead;
      for(const event of events){const size=Buffer.byteLength(JSON.stringify(event))+1;
        if(chunks.at(-1)!.length&&(bytes+size>SYNC_BODY_BYTES||chunks.at(-1)!.length===SYNC_CHUNK_EVENTS)){chunks.push([]);bytes=overhead;}
        chunks.at(-1)!.push(event);bytes+=size;
      }
      const contentHash=hash(JSON.stringify(thread)+'|'+chunks.map(c=>hash(JSON.stringify(c))).join('|'));
      const previous=this.store.one<Pending>('SELECT * FROM usage_sync_outbox WHERE id=?',[row.id]);
      if(previous?.payload)continue; // Finish an in-flight revision before coalescing later changes.
      if(previous?.hash===contentHash)continue;
      const revision=Number(previous?.revision||0)+1;
      const manifest:SyncManifest={schemaVersion:2,datasetId:this.state.datasetId,thread,revision,parserVersion:USAGE_PARSER_VERSION,
        collectedAt:this.collection?.().updatedAt||new Date(this.now()).toISOString(),eventCount:events.length,chunkCount:chunks.length,contentHash};
      if(chunks.some((events,index)=>!validChunk({manifest,index,events})||Buffer.byteLength(JSON.stringify({manifest,index,events}))>SYNC_BODY_BYTES))throw new Error('INVALID_LOCAL_STATISTICS');
      this.store.run(`INSERT INTO usage_sync_outbox(id,revision,hash,payload,chunk) VALUES(?,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,payload=excluded.payload,chunk=0`,[row.id,revision,contentHash,JSON.stringify({manifest,chunks})]);
    }
    this.state.total=Number(this.store.one('SELECT COUNT(*) n FROM usage_sync_outbox')!.n);this.state.scannedAt=this.now();this.save();
  }
  private async send(route:string,method:string,body?:unknown){
    const result=await this.transport(route,method,body);
    if(!result.response.ok){
      const wait=Number(result.response.headers.get('retry-after')||0)*1000;
      const error=Object.assign(new Error(result.data.error?.code||'SYNC_FAILED'),{route,status:result.response.status,wait,acceptedSequence:result.data.acceptedSequence});throw error;
    }return result.data;
  }
  async tick(deviceId:string,current:()=>boolean,mode:'all'|'accounts'='all'){
    if(!current()||this.now()<this.state.nextAt)return;
    if(this.state.deviceId!==deviceId){this.store.run('DELETE FROM usage_sync_outbox');this.state={...this.state,deviceId,scannedAt:0,initialComplete:false,uploadedAt:null,collectedAt:null,accountHash:null,accountNextAt:0};this.save();}
    try{
      const config=await this.send('sync/config','GET');if(!current())return;
      if(config.paused){this.state.nextAt=this.now()+60000;this.state.error='云端已暂停此设备。';this.save();return;}
      if(typeof config.accountKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(config.accountKey))throw new Error('INVALID_CONFIG');
      if(mode==='all'&&!this.collection?.().running && (!this.state.scannedAt||this.now()-this.state.scannedAt>=60000))this.scan();
      let pending=mode==='all'?this.store.one<Pending>('SELECT * FROM usage_sync_outbox WHERE payload IS NOT NULL ORDER BY id LIMIT 1'):undefined;
      for(let budget=0;pending&&budget<4&&current();budget++){
        const payload=JSON.parse(pending.payload!) as {manifest:SyncManifest;chunks:SyncEvent[][]};
        const index=Number(pending.chunk);
        if(index<payload.chunks.length){await this.send('sync/chunks','PUT',{manifest:payload.manifest,index,events:payload.chunks[index]});if(!current())return;
          this.store.run('UPDATE usage_sync_outbox SET chunk=chunk+1 WHERE id=? AND revision=?',[pending.id,Number(pending.revision)]);
        }else{await this.send('sync/commit','POST',payload.manifest);if(!current())return;
          this.store.run('UPDATE usage_sync_outbox SET payload=NULL WHERE id=? AND revision=?',[pending.id,Number(pending.revision)]);}
        pending=this.store.one<Pending>('SELECT * FROM usage_sync_outbox WHERE payload IS NOT NULL ORDER BY id LIMIT 1');
      }
      if(!current())return;
      if(this.now()>=this.state.accountNextAt){
        const observation=await this.observe();if(!current())return;
        // Never use the process-scoped fallback identity key for cross-device grouping.
        const stable=observation.stableIdentity || null;
        const ref=observation.identityKnown&&stable?createHmac('sha256',config.accountKey).update(stable).digest('hex'):null;
        const quota=cloudSnapshot(observation,{salt:config.accountKey},deviceId,this.state.accountSequence+1);
        quota.accountRef=ref;if(!ref){quota.status='identity_unknown';quota.collectedAt=null;quota.provider=null;quota.buckets=[];quota.errorCode='IDENTITY_UNKNOWN';}
        let history=ref&&this.history?await this.history():null;if(!current())return;
        if(history?.identityKey!==observation.identityKey||history?.data?.accountId!==observation.data?.accountId)history=null;
        const data=history?.data;
        const safeHistory=data?{summary:{lifetimeTokens:data.summary.lifetimeTokens,peakDailyTokens:data.summary.peakDailyTokens,longestRunningTurnSec:data.summary.longestRunningTurnSec,
          currentStreakDays:data.summary.currentStreakDays,longestStreakDays:data.summary.longestStreakDays},dailyUsageBuckets:data.dailyUsageBuckets?.map(b=>({startDate:b.startDate,tokens:b.tokens}))??null}:null;
        const body:CloudAccountSnapshot={schemaVersion:2,quota,history:safeHistory,historyCollectedAt:safeHistory?history!.collectedAt:null};
        const digest=hash(JSON.stringify({...body,quota:{...quota,sequence:0}}));
        if(digest!==this.state.accountHash){
          // Persist the sequence before sending: interrupted attempts may safely resend a newer version.
          this.state.accountSequence++;this.save();await this.send('sync/accounts','PUT',body);if(!current())return;this.state.accountHash=digest;
        }
        this.state.accountNextAt=this.now()+60000;
      }
      if(mode==='accounts'){this.state.nextAt=this.now()+15000;this.state.failures=0;this.state.error=null;this.save();return;}
      const collectionAt=this.collection?.().updatedAt||this.store.one('SELECT MAX(updated_at) at FROM source_files')?.at||null;
      this.state.initialComplete ||= !!this.state.scannedAt&&!pending;
      await this.send('sync/status','PUT',{collectedAt:collectionAt,totalThreads:this.state.total,initialComplete:!!this.state.initialComplete,error:this.collection?.().error?'COLLECTION_FAILED':null});if(!current())return;
      this.state.uploadedAt=new Date(this.now()).toISOString();this.state.collectedAt=collectionAt;
      this.state.nextAt=this.now()+(pending?1000:15000);this.state.failures=0;this.state.error=null;this.save();
    }catch(error){if(!current())return;const e=error as Error&{route?:string;status?:number;wait?:number;acceptedSequence?:number};
      if(e.route==='sync/accounts'&&e.message==='STALE_SEQUENCE'&&Number.isSafeInteger(e.acceptedSequence)){this.state.accountSequence=Math.max(this.state.accountSequence,e.acceptedSequence!);this.state.accountHash=null;}
      if(['sync/chunks','sync/commit'].includes(e.route||'')&&['STALE_SEQUENCE','REVISION_CONFLICT','INCOMPLETE_REVISION'].includes(e.message)){
        const pending=this.store.one<Pending>('SELECT * FROM usage_sync_outbox WHERE payload IS NOT NULL ORDER BY id LIMIT 1');
        if(pending){const payload=JSON.parse(pending.payload!);if(e.message!=='INCOMPLETE_REVISION')payload.manifest.revision=Math.max(Number(pending.revision),Number(e.acceptedSequence)||0)+1;
          this.store.run('UPDATE usage_sync_outbox SET revision=?,payload=?,chunk=0 WHERE id=?',[payload.manifest.revision,JSON.stringify(payload),pending.id]);}
      }
      this.state.failures++;this.state.error=e.status===401?'设备已撤销，请重新绑定。':e.status===423?'云端已暂停此设备。':'用量同步失败，正在重试；已同步数据仍可查看。';
      this.state.nextAt=this.now()+Math.max(e.wait||0,Math.min(900000,5000*2**Math.min(this.state.failures,7)));this.save();
    }
  }
}
