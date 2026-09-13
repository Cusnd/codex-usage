// Design experiment only: real current scan/reconcile vs bounded prototypes.
// All databases are synthetic and in-memory; transport is forbidden.
// node --import tsx --expose-gc docs/design/benchmarks/incremental-work-2026-09-11.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../../../server/db.ts';
import { UsageSync } from '../../../server/usage-sync.ts';
import { SyncEventSchema } from '../../../shared/usage-sync.ts';
import { Value } from '@sinclair/typebox/value';

const at = '2026-09-11T00:00:00.000Z';
const tokenFields = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const median = list => [...list].sort((a,b)=>a-b)[Math.floor(list.length/2)];
const round = n => Number(n.toFixed(3));
const measure = fn => {const a=performance.now(), value=fn(); return {ms:performance.now()-a, value};};
function makeEvent(i) {
  return {event_key:'response:'+i,thread_id:'one-large-thread',turn_id:'turn:'+i,response_id:String(i),at,
    project:'/synthetic/project',model:'synthetic-model',effort:'high',kind:'record',incomplete:0,
    input_tokens:'10000',cached_input_tokens:'7000',cache_write_input_tokens:null,
    output_tokens:'1000',reasoning_output_tokens:'500',total_tokens:'11000'};
}
function makeFixture(count) {
  const store = new Store(':memory:');
  store.run('INSERT INTO threads(id,title,project) VALUES(?,?,?)',['one-large-thread','Synthetic title','/synthetic/project']);
  const insert = store.db.prepare(`INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,incomplete,active,${tokenFields.join(',')}) VALUES(${Array(18).fill('?').join(',')})`);
  const add = event => insert.run('synthetic-file', event.event_key,event.thread_id,event.turn_id,event.response_id,event.at,event.project,event.model,event.effort,event.kind,event.incomplete,1,
    ...tokenFields.map(f=>event[f]===null?null:BigInt(event[f])));
  store.transaction(()=>{for(let i=0;i<count;i++)add(makeEvent(i));});
  store.db.exec(`CREATE TABLE proto_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_type TEXT,entity_id TEXT,payload TEXT);
    CREATE TABLE proto_pending(entity_type TEXT,entity_id TEXT,seq INTEGER,PRIMARY KEY(entity_type,entity_id));
    CREATE INDEX proto_pending_seq ON proto_pending(seq);
    CREATE TABLE proto_outbox(id INTEGER PRIMARY KEY,hash TEXT,bytes BLOB);`);
  const sync = new UsageSync(store, async()=>{throw new Error('No network permitted in experiment');},async()=>{throw new Error('No account reads permitted');},undefined,()=>Date.parse(at),()=>({running:false,updatedAt:at,error:null}));
  const originalAll = store.all.bind(store);
  let materialized=0;
  store.all = (sql,params=[]) => {
    const rows=originalAll(sql,params);
    if(sql.startsWith('SELECT * FROM effective_events WHERE thread_id='))materialized+=rows.length;
    return rows;
  };
  const acknowledgeBaseline = ()=>store.run('UPDATE usage_sync_outbox SET payload=NULL');
  // TS private method is intentionally invoked only to isolate this stage.
  sync.scan(); acknowledgeBaseline(); materialized=0;
  const changes = store.db.prepare('INSERT INTO proto_changes(entity_type,entity_id,payload) VALUES(?,?,?)');
  const pending = store.db.prepare('INSERT INTO proto_pending VALUES(?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET seq=excluded.seq');
  function journal(items) {
    store.transaction(()=>{for(const item of items){const result=changes.run(item.type,item.id,JSON.stringify(item.value));pending.run(item.type,item.id,result.lastInsertRowid);}});
  }
  function takePending() {
      // A real transaction seals payload and removes only the claimed revisions.
      let stats;
      store.transaction(()=>{
        const rows=store.all('SELECT c.seq,c.entity_type,c.entity_id,c.payload FROM proto_pending p JOIN proto_changes c ON c.seq=p.seq ORDER BY p.seq LIMIT 1000');
        if(!rows.length){stats={entities:0,events:0,bytes:0};return;}
        const entities=rows.map(row=>({type:row.entity_type,id:row.entity_id,value:JSON.parse(row.payload)}));
        for(const entity of entities)if(entity.type==='event')assert(Value.Check(SyncEventSchema,entity.value));
        const bytes=Buffer.from(JSON.stringify({experimentVersion:1,entities}));
        const hash=createHash('sha256').update(bytes).digest('hex');
        store.run('INSERT INTO proto_outbox(hash,bytes) VALUES(?,?)',[hash,bytes]);
        for(const row of rows)store.run('DELETE FROM proto_pending WHERE entity_type=? AND entity_id=? AND seq=?',[row.entity_type,row.entity_id,Number(row.seq)]);
        stats={entities:entities.length,events:entities.filter(e=>e.type==='event').length,bytes:bytes.length};
      });
      return stats;
  }
  return {store,sync,add,journal,takePending,acknowledgeBaseline,resetReads(){materialized=0;},get reads(){return materialized;}};
}
const syncResults=[], reconcileResults=[];
for(const historySize of [1000,10000,100000]) {
  const f=makeFixture(historySize);let nextId=historySize;
  try {
    for(const scenario of ['idle','append-10','metadata-only']) {
      const samples=[];
      for(let r=0;r<7;r++) {
        let items=[];
        if(scenario==='append-10') {
          const events=Array.from({length:10},()=>makeEvent(nextId++));
          f.store.transaction(()=>events.forEach(f.add));
          items=events.map(value=>({type:'event',id:value.event_key,value}));
        } else if(scenario==='metadata-only') {
          const title='Revised title '+r;
          f.store.run('UPDATE threads SET title=?,title_updated_at=? WHERE id=?',[title,at,'one-large-thread']);
          const value=f.store.one('SELECT * FROM threads WHERE id=?',['one-large-thread']);
          items=[{type:'thread',id:'one-large-thread',value}];
        }
        const producer=items.length?measure(()=>f.journal(items)):{ms:0};
        let baseline,incremental;
        f.resetReads();
        if(r%2===0){baseline=measure(()=>f.sync.scan());incremental=measure(()=>f.takePending());}
        else{incremental=measure(()=>f.takePending());baseline=measure(()=>f.sync.scan());}
        const queued=f.store.one('SELECT payload FROM usage_sync_outbox WHERE id=?',['one-large-thread'])?.payload;
        const currentPayload=queued?JSON.parse(queued):null;
        const currentEvents=currentPayload?.chunks.reduce((n,c)=>n+c.length,0)||0;
        assert.equal(incremental.value.events,scenario==='append-10'?10:0);
        assert.equal(incremental.value.entities,items.length);
        assert.equal(!!currentPayload,scenario!=='idle');
        if(r>=2)samples.push({
          current_scan_ms:baseline.ms,prototype_journal_ms:producer.ms,prototype_seal_ms:incremental.ms,
          prototype_journal_plus_seal_ms:producer.ms+incremental.ms,
          current_events_materialized:f.reads,current_queued_event_rows:currentEvents,
          prototype_queued_event_rows:incremental.value.events,current_queued_payload_bytes:queued?Buffer.byteLength(queued):0,
          prototype_queued_payload_bytes:incremental.value.bytes,
        });
        f.acknowledgeBaseline();
        f.store.run('DELETE FROM proto_outbox');
      }
      syncResults.push({initial_history_events:historySize,scenario,...Object.fromEntries(Object.keys(samples[0]).map(key=>[key,round(median(samples.map(s=>s[key])))]))});
    }
    // Narrow exact-record case only. Legacy/turn replacement is checked separately.
    const keys=Array.from({length:10},(_,i)=>'response:'+i), placeholders=keys.map(()=>'?').join(',');
    const totalChanges=()=>Number(f.store.db.prepare('SELECT total_changes() n').get().n);
    const allActive=()=>Number(f.store.one('SELECT COUNT(*) n FROM usage_events WHERE active=1').n);
    const samples=[];
    function affectedKeys() {
      f.store.transaction(()=>{
        f.store.run(`UPDATE usage_events SET active=0 WHERE event_key IN (${placeholders})`,keys);
        f.store.run(`UPDATE usage_events SET active=1 WHERE rowid IN (SELECT event_rowid FROM (
          SELECT e.rowid event_rowid,ROW_NUMBER() OVER(PARTITION BY event_key ORDER BY incomplete,file) rank FROM usage_events e
          WHERE event_key IN (${placeholders}) AND excluded=0 AND (kind='record' OR turn_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM usage_events r WHERE r.kind='record' AND r.excluded=0 AND r.thread_id=e.thread_id AND r.turn_id=e.turn_id))) WHERE rank=1)`,keys);
      });
    }
    for(let r=0;r<7;r++) {
      const expected=allActive();let a=totalChanges();
      const full=measure(()=>f.store.transaction(()=>f.store.reconcile(['one-large-thread']))),fullWrites=totalChanges()-a;
      assert.equal(allActive(),expected);a=totalChanges();
      const narrow=measure(affectedKeys),narrowWrites=totalChanges()-a;
      assert.equal(allActive(),expected);
      if(r>=2)samples.push({current_reconcile_ms:full.ms,prototype_affected_keys_ms:narrow.ms,current_updated_rows:fullWrites,prototype_updated_rows:narrowWrites});
    }
    reconcileResults.push({initial_history_events:historySize,affected_events:10,...Object.fromEntries(Object.keys(samples[0]).map(key=>[key,round(median(samples.map(s=>s[key])))]))});
  } finally {f.store.close();}
  globalThis.gc?.();
}
console.log(JSON.stringify({experiment:'real current scan/reconcile vs isolated incremental prototypes',node:process.version,platform:process.platform,arch:process.arch,
  measured_at:new Date().toISOString(),warmup_rounds:2,measured_rounds:5,statistic:'median',
  limitations:[
    'All sources and databases are synthetic and in memory; one large thread deliberately tests history growth inside a task.',
    'Current scan and reconcile invoke repository implementations; prototypes live only in this design experiment.',
    'Normalized source insertion is shared and outside timing. Incremental journal creation, payload construction, hashing and outbox transaction are timed.',
    'Initial cache population, initial scan and simulated acknowledgement are outside timing. Append trials add 10 rows each without clearing history.',
    'No raw-log parsing, compression, network, cloud, browser, persistent-disk fsync, crash recovery or end-to-end latency measurement.',
    'Prototype payload is not a finalized protocol; timing magnitudes are stage observations, not production speedup guarantees.',
    'Reconcile prototype covers known explicit event identities only; changes to legacy suppression require expansion to the affected turn.',
    'Updated rows count SQLite UPDATE effects, not physical pages or bytes; materialized rows count SQL result rows, not all database index visits.',
  ],sync_results:syncResults,reconcile_results:reconcileResults},null,2));
