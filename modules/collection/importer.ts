import path from 'node:path';
import type {Store} from '../storage/sqlite.js';
import {Collector,type CollectionMetrics} from './collector.js';
import {LocalMaterializer} from './materializer.js';
import {ProjectSourceResolver,type ResolvedProjectSource} from '../organization/source-node.js';
import type { SyncMetadata } from '../contracts/sync.js';
import {sha256} from './projection.js';
import { stableJson } from '../contracts/sync.js';

export type ImportProgress={filesScanned:number;filesChanged:number;events:number;issues:number};
export interface LocalImporter {stopped:boolean;scan(progress?:(value:ImportProgress)=>void):Promise<void>;close?():Promise<void>}

/** Keeps the local API while the collector supplies both local and cloud consumers. */
export class StreamingImporter implements LocalImporter {
  stopped=false;readonly collector:Collector;readonly projects:ProjectSourceResolver;
  private progress:((value:ImportProgress)=>void)|undefined;
  constructor(private store:Store,root:string,options:{stateRoot?:string;onCycle?:(progress:ImportProgress,metrics:CollectionMetrics)=>void;onError?:(error:unknown)=>void}={}) {
    store.db.exec('CREATE TABLE IF NOT EXISTS collector_projects(id TEXT PRIMARY KEY,raw_identity TEXT NOT NULL,value TEXT NOT NULL)');
    const materializer=new LocalMaterializer(store);
    this.collector=new Collector(store,{sourceRoot:root,stateRoot:options.stateRoot,identityFile:options.stateRoot?path.join(options.stateRoot,'collector-identity.json'):null,
      onBatch:batch=>materializer.apply(batch),resolveProject:async(cwd,threadId)=>{
        const project=await this.projects.resolve({cwd,threadId});if(!project.sourceProjectId)return {id:null};
        const id='project:'+sha256(project.sourceProjectId);
        this.store.run('INSERT OR REPLACE INTO collector_projects VALUES(?,?,?)',[id,project.sourceProjectId,JSON.stringify(project)]);
        const metadata=this.metadata(id,project);
        return {id,metadata:[metadata]};
      },onCycle:metrics=>{const status=this.publishStatus(metrics);this.progress?.(status);options.onCycle?.(status,metrics);},onError:options.onError});
    const previous=store.all('SELECT value FROM collector_projects').map(row=>JSON.parse(row.value) as ResolvedProjectSource);
    this.projects=new ProjectSourceResolver({collectorId:this.collector.id,codexRoot:root,previous});
  }
  private metadata(id:string,project:ResolvedProjectSource):SyncMetadata {return {type:'project',source_project_id:id,value:{id,kind:project.kind,name:project.name,root:project.root,app_project_id:project.appProjectId,
    repository:project.git?.primary.identity?.key??null,common_dir:project.git?.commonDirectory??null,confidence:project.git?.primary.status??project.provenance.method,reason:project.provenance.reason}};}
  private async refreshMetadata(){
    const changes:SyncMetadata[]=[],updates:{id:string;value:string}[]=[];
    for(const row of this.store.all('SELECT id,value FROM collector_projects')){
      const old=JSON.parse(row.value) as ResolvedProjectSource,project=await this.projects.resolve({cwd:old.observedCwd,threadId:old.sessionId});
      if(!project.sourceProjectId||'project:'+sha256(project.sourceProjectId)!==row.id)continue;
      const value=this.metadata(row.id,project);if(stableJson(value)===stableJson(this.metadata(row.id,old)))continue;
      updates.push({id:row.id,value:JSON.stringify(project)});changes.push(value);
    }
    this.collector.enqueueMetadata(changes);
    for(const row of updates)this.store.run('UPDATE collector_projects SET value=? WHERE id=?',[row.value,row.id]);
    // An App assignment can change source identity without appending a token record.
    for(const row of this.store.all("SELECT id,path,state FROM collector_sources WHERE kind='session' AND available=1")){
      const context=JSON.parse(row.state).context;if(!context)continue;
      const resolved=await this.projects.resolve({cwd:context.cwd,threadId:context.thread_id}),id=resolved.sourceProjectId?'project:'+sha256(resolved.sourceProjectId):null;
      if(id!==context.source_project_id){this.store.run('UPDATE collector_sources SET reset_required=1,version=version+1 WHERE id=?',[row.id]);this.collector.notify(row.path,false);}
    }
  }
  private publishStatus(metrics:CollectionMetrics):ImportProgress {
    const now=new Date().toISOString();
    // One atomic mirror write avoids one durable SQLite commit per source on
    // every scan, including scans that read no new source bytes.
    this.store.run(`INSERT INTO source_files(path,identity,size,mtime,offset,fingerprint,state,issues,updated_at)
      SELECT path,identity,size,CAST(mtime AS REAL),offset,prefix_sha,state,issues,? FROM collector_sources WHERE true
      ON CONFLICT(path) DO UPDATE SET identity=excluded.identity,size=excluded.size,mtime=excluded.mtime,offset=excluded.offset,fingerprint=excluded.fingerprint,state=excluded.state,issues=excluded.issues,updated_at=excluded.updated_at`,[now]);
    return {filesScanned:metrics.discovered||metrics.processed,filesChanged:metrics.processed-metrics.unchanged,events:Number(this.store.one('SELECT COUNT(*) n FROM effective_events')!.n),issues:Number(this.store.one('SELECT COALESCE(SUM(issues),0) n FROM collector_sources')!.n)};
  }
  async scan(progress?:(value:ImportProgress)=>void) {
    if(this.stopped)return;this.progress=progress;
    try{await this.projects.refresh();await this.refreshMetadata();const result=await this.collector.scan();if(result.errors.length)throw Object.assign(Error('部分来源采集失败；已保存进度，可重新刷新继续。'),{code:result.errors[0].code});}
    finally{this.progress=undefined;}
  }
  startWatching() {if(!this.stopped)this.collector.startWatching();}
  stopWatching() {this.collector.stopWatching();}
  async close() {this.stopped=true;await this.collector.close();}
}
