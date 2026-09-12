import type {Store} from '../storage/sqlite.js';
import {TOKEN_FIELDS,type Candidate,type LegacyState,type Observation,type ThreadChange,type CanonicalEvent} from '../usage/types.js';
import {consumeProjected,initialLegacyState} from '../usage/normalize.js';
import {canonicalize,reconcileTurns} from '../usage/canonical.js';
import { stableJson, type UploadBatch } from '../contracts/sync.js';

/** Called inside the collector consumer transaction; no filesystem or network reads. */
export class LocalMaterializer {
  constructor(private store:Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS local_v3_sources(collector_id TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,thread_id TEXT NOT NULL,cursor INTEGER NOT NULL,state TEXT NOT NULL,complete INTEGER NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(collector_id,source_id,generation));
      CREATE TABLE IF NOT EXISTS local_v3_candidates(observation_id TEXT PRIMARY KEY,collector_id TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,event_id TEXT NOT NULL,thread_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_v3_candidates_event ON local_v3_candidates(event_id);
      CREATE INDEX IF NOT EXISTS local_v3_candidates_source ON local_v3_candidates(collector_id,source_id,generation);
      CREATE INDEX IF NOT EXISTS local_v3_candidates_thread ON local_v3_candidates(thread_id);
      CREATE INDEX IF NOT EXISTS local_v3_candidates_turn ON local_v3_candidates(thread_id,json_extract(data,'$.turn_id'));
      CREATE INDEX IF NOT EXISTS local_v3_candidates_signature ON local_v3_candidates(thread_id,json_extract(data,'$.signature'),json_extract(data,'$.at'));
      CREATE INDEX IF NOT EXISTS local_v3_sources_thread ON local_v3_sources(thread_id,active);
      CREATE TABLE IF NOT EXISTS local_v3_dependencies(collector_id TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,observation_id TEXT NOT NULL,locator INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collector_id,source_id,generation,observation_id));
      CREATE TABLE IF NOT EXISTS local_v3_events(event_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_v3_threads(collector_id TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,observation_id TEXT NOT NULL,locator INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collector_id,source_id,generation,observation_id));
      CREATE INDEX IF NOT EXISTS local_v3_deferred_parent ON local_v3_sources(json_extract(state,'$.parent_id')) WHERE active=1 AND json_extract(state,'$.deferred')=1;
    `);
  }
  private dependencyView() {
    return {
      parentStatus:(thread:string,_cutoff:string):'missing'|'partial'|'complete'=>{
        const rows=this.store.all('SELECT complete FROM local_v3_sources WHERE thread_id=? AND active=1',[thread]);
        return rows.some(r=>Number(r.complete)===1)?'complete':rows.length?'partial':'missing';
      },
      parentHasSignature:(thread:string,signature:string,cutoff:string)=>!!this.store.one(`SELECT 1 FROM local_v3_candidates c JOIN local_v3_sources s USING(collector_id,source_id,generation) WHERE c.thread_id=? AND json_extract(c.data,'$.signature')=? AND json_extract(c.data,'$.at')<=? AND s.active=1 LIMIT 1`,[thread,signature,cutoff]),
    };
  }
  private thread(t:ThreadChange) {
    if(t.title!==undefined){this.store.run(`INSERT INTO threads(id,title,title_updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_updated_at=excluded.title_updated_at WHERE threads.title_updated_at IS NULL OR threads.title_updated_at<=excluded.title_updated_at`,[t.id,t.title??null,t.title_updated_at??null]);return;}
    this.store.run(`INSERT INTO threads(id,project,source,parent_id,subagent_parent_id,forked_from_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=COALESCE(excluded.project,threads.project),source=COALESCE(excluded.source,threads.source),parent_id=excluded.parent_id,subagent_parent_id=excluded.subagent_parent_id,forked_from_id=excluded.forked_from_id`,[t.id,t.project,t.source,t.parent_id,t.subagent_parent_id,t.forked_from_id]);
  }
  private candidate(collector:string,c:Candidate,affected:Set<string>,turns:Set<string>) {
    const old=this.store.one('SELECT event_id,data FROM local_v3_candidates WHERE observation_id=?',[c.observation_id]);
    if(old){const previous=JSON.parse(old.data) as Candidate;if(previous.record_revision>c.record_revision)return;if(previous.record_revision===c.record_revision&&stableJson(previous)!==stableJson(c))throw Error('REVISION_CONFLICT');affected.add(old.event_id);if(previous.turn_id!==null)turns.add(stableJson([previous.thread_id,previous.turn_id]));}
    this.store.run('INSERT OR REPLACE INTO local_v3_candidates VALUES(?,?,?,?,?,?,?)',[c.observation_id,collector,c.source_id,c.generation,c.event_id,c.thread_id,stableJson(c)]);affected.add(c.event_id);
    if(c.turn_id!==null)turns.add(stableJson([c.thread_id,c.turn_id]));
  }
  apply(batch:UploadBatch) {
    const affected=new Set<string>(),changedThreads=new Set<string>(),changedTurns=new Set<string>();
    for(const source of batch.sources) {
      const key=[batch.collector_id,source.source_id,source.generation],previous=this.store.one('SELECT * FROM local_v3_sources WHERE collector_id=? AND source_id=? AND generation=?',key);
      if(previous&&Number(previous.cursor)!==source.from_cursor)throw Error('LOCAL_CURSOR_CONFLICT');
      if(!previous&&source.from_cursor!==0)throw Error('LOCAL_SOURCE_GAP');
      const oldActive=this.store.one('SELECT generation FROM local_v3_sources WHERE collector_id=? AND source_id=? AND active=1',[batch.collector_id,source.source_id]);
      const active=oldActive?Number(oldActive.generation)===source.generation:true;
      let state:LegacyState=previous?JSON.parse(previous.state):initialLegacyState(source.context.thread_id);
      const observations=batch.records.filter(o=>o.source_id===source.source_id&&o.generation===source.generation);
      for(const o of observations) {
        const result=consumeProjected(state,o,this.dependencyView());state=result.state;
        for(const t of result.threads){
          this.store.run('INSERT OR REPLACE INTO local_v3_threads VALUES(?,?,?,?,?,?)',[...key,o.observation_id,o.locator,stableJson(t)]);
          if(active){this.thread(t);changedThreads.add(t.id);}
        }
        for(const c of result.candidates)this.candidate(batch.collector_id,c,affected,changedTurns);
        // Only potentially inherited sources need retained white-listed parser dependencies.
        if(state.parent_id)this.store.run('INSERT OR REPLACE INTO local_v3_dependencies VALUES(?,?,?,?,?,?)',[...key,o.observation_id,o.locator,stableJson(o)]);
      }
      this.store.run('INSERT OR REPLACE INTO local_v3_sources VALUES(?,?,?,?,?,?,?,?)',[...key,state.thread_id,source.to_cursor,stableJson(state),source.generation_complete?1:0,active?1:0]);
      changedThreads.add(state.thread_id);
      if(source.replace_end&&source.generation_complete) {
        if(!active)for(const row of this.store.all('SELECT data FROM local_v3_candidates WHERE collector_id=? AND source_id=?',[batch.collector_id,source.source_id])){const c=JSON.parse(row.data) as Candidate;affected.add(c.event_id);if(c.turn_id!==null)changedTurns.add(stableJson([c.thread_id,c.turn_id]));}
        this.store.run('UPDATE local_v3_sources SET active=CASE WHEN generation=? THEN 1 ELSE 0 END WHERE collector_id=? AND source_id=?',[source.generation,batch.collector_id,source.source_id]);
        this.store.run('DELETE FROM local_v3_candidates WHERE collector_id=? AND source_id=? AND generation<>?',key);
        this.store.run('DELETE FROM local_v3_dependencies WHERE collector_id=? AND source_id=? AND generation<>?',key);
        this.store.run('DELETE FROM local_v3_threads WHERE collector_id=? AND source_id=? AND generation<>?',key);
        if(!active)for(const row of this.store.all('SELECT data FROM local_v3_threads WHERE collector_id=? AND source_id=? AND generation=? ORDER BY locator',key))this.thread(JSON.parse(row.data) as ThreadChange);
      }
    }
    // Parent arrival changes the interpretation of the child's prefix, including complete sources.
    for(let pass=0;pass<32;pass++) {
      let resolved=false;
      for(const source of this.store.all("SELECT * FROM local_v3_sources WHERE active=1 AND json_extract(state,'$.deferred')=1 AND json_extract(state,'$.parent_id') IN (SELECT value FROM json_each(?))",[JSON.stringify([...changedThreads])])) {
        const old=JSON.parse(source.state) as LegacyState;if(!old.deferred||!old.parent_id||!changedThreads.has(old.parent_id))continue;
        const dependency=this.dependencyView();if(dependency.parentStatus(old.parent_id,old.cutoff||'')!=='complete')continue;
        const key=[source.collector_id,source.source_id,Number(source.generation)];let state=initialLegacyState(source.thread_id);
        const inputs=this.store.all('SELECT data FROM local_v3_dependencies WHERE collector_id=? AND source_id=? AND generation=? ORDER BY locator',key);
        for(const input of inputs){const result=consumeProjected(state,JSON.parse(input.data) as Observation,dependency);state=result.state;
          for(const c of result.candidates){const row=this.store.one('SELECT event_id FROM local_v3_candidates WHERE observation_id=?',[c.observation_id]);if(row)affected.add(row.event_id);this.store.run('DELETE FROM local_v3_candidates WHERE observation_id=?',[c.observation_id]);this.candidate(source.collector_id,c,affected,changedTurns);}}
        this.store.run('UPDATE local_v3_sources SET state=? WHERE collector_id=? AND source_id=? AND generation=?',[stableJson(state),...key]);changedThreads.add(state.thread_id);
        if(!state.deferred){this.store.run('DELETE FROM local_v3_dependencies WHERE collector_id=? AND source_id=? AND generation=?',key);resolved=true;}
      }
      if(!resolved)break;
    }
    // A newly explicit event suppresses every legacy candidate in that turn, not just its own event ID.
    for(const turn of changedTurns){const [threadId,turnId]=JSON.parse(turn);for(const row of this.store.all("SELECT DISTINCT event_id FROM local_v3_candidates WHERE thread_id=? AND json_extract(data,'$.turn_id')=?",[threadId,turnId]))affected.add(row.event_id);}
    const candidates=this.store.all(`SELECT c.data FROM local_v3_candidates c JOIN local_v3_sources s USING(collector_id,source_id,generation) WHERE s.active=1 AND c.event_id IN (SELECT value FROM json_each(?))`,[JSON.stringify([...affected])]).map(r=>JSON.parse(r.data) as Candidate);
    const eligible=reconcileTurns(candidates),byEvent=new Map<string,Candidate[]>();for(const c of eligible){const list=byEvent.get(c.event_id)||[];list.push(c);byEvent.set(c.event_id,list);}
    for(const id of affected) {
      const event=canonicalize(byEvent.get(id)||[]);this.store.run('DELETE FROM usage_events WHERE file=? AND event_key=?',['v3:canonical',id]);
      if(!event){this.store.run('DELETE FROM local_v3_events WHERE event_id=?',[id]);continue;}
      this.store.run('INSERT OR REPLACE INTO local_v3_events VALUES(?,?)',[id,stableJson(event)]);this.mirror(event);
    }
  }
  private mirror(event:CanonicalEvent) {
    // TEXT storage preserves exact decimals; the shared query planner selects safe SQL or BigInt.
    const numbers=TOKEN_FIELDS.map(k=>event[k]);
    this.store.run(`INSERT OR REPLACE INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,signature,${TOKEN_FIELDS.join(',')},incomplete,excluded,active,service_tier,service_tier_source) VALUES(${Array(22).fill('?').join(',')})`,
      ['v3:canonical',event.event_id,event.thread_id,event.turn_id,event.response_id,event.at,event.project,event.model,event.effort,event.kind,null,...numbers,event.incomplete?1:0,0,1,event.service_tier??'unknown',event.service_tier_source??'unknown']);
  }
}
