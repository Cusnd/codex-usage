import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/db.js';
import { Queries } from '../server/queries.js';
import { QueryEngine, queryStore, type Statement } from '../shared/query-engine.js';
import { EXACT_EVENT_PAGE_SIZE, canAggregateInSql } from '../shared/exact-query-engine.js';
import { tokenFields } from '../shared/query-values.js';
import { seedExample } from '../showcase/fixture.js';
import { exampleSettings } from '../showcase/store.js';

const at = '2026-11-01T05:30:00.000Z';
function add(store: Store, id: string, values: Record<string, any> = {}) {
  const row = { file: 'fixture', event_key: id, thread_id: id, turn_id: 'turn', response_id: id, at,
    project: '/work/project', model: 'priced', effort: 'high', kind: 'record', incomplete: 0, excluded: 0, active: 1, service_tier: 'standard', service_tier_source: 'record',
    input_tokens: '100', cached_input_tokens: '25', cache_write_input_tokens: '10', output_tokens: '20', reasoning_output_tokens: '5', total_tokens: '120', ...values };
  store.run(`INSERT INTO usage_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`, Object.values(row));
  store.run('INSERT OR IGNORE INTO threads(id,title,project) VALUES(?,?,?)',[row.thread_id,'Title '+row.thread_id,row.project]);
}
function drive<T>(store: Store, generator: Generator<Statement,T,any>, transport = false): T {
  let next = generator.next();
  while (!next.done) {
    const statement = next.value, value = statement.one ? store.one(statement.sql,statement.params) : store.all(statement.sql,statement.params);
    const passed = transport ? JSON.parse(JSON.stringify(value, (_key,v)=>{
      if (typeof v !== 'bigint') return v;
      assert.ok(v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER), 'An uncast integer crossed the D1 transport boundary'); return Number(v);
    })) : value;
    next = generator.next(passed);
  }
  return next.value;
}
function forcedFallback(store: Store) {
  return new Queries({ all:store.all.bind(store), settings:store.settings.bind(store), readSnapshot:store.readSnapshot.bind(store),
    one<T = Record<string,any>>(sql:string,params?:SQLInputValue[]) { const row = store.one(sql,params); return (sql.includes('total_tokens_digits') ? {...row,total_tokens_digits:40} : row) as T|undefined; } });
}

test('a legal 128-bit token value remains exact through storage, summary, sorting and cost', () => {
  const store = new Store(':memory:');
  try {
    const input=2n**120n,cached=2n**100n,write=2n**90n,output=7n,total=input+output;
    add(store,'huge',{input_tokens:String(input),cached_input_tokens:String(cached),cache_write_input_tokens:String(write),output_tokens:String(output),total_tokens:String(total)});
    add(store,'small');
    store.saveSettings({...store.settings(),costEnabled:true,officialApiPricing:true,modelPrices:[{model:'priced',input:'1',cachedInput:'0.5',cacheWrite:'2',output:'3',longContextThreshold:null,longInput:null,longCachedInput:null,longCacheWrite:null,longOutput:null}]});
    const q = new Queries(store), summary=q.summary({threadId:'huge'});
    assert.equal(summary.totalTokens,String(total)); assert.equal(summary.inputTokens,String(input)); assert.equal(summary.uncachedInputTokens,String(input-cached)); assert.equal(summary.ordinaryInputTokens,String(input-cached-write));
    const cost=(input-cached)*1000000n+cached*500000n+write*1000000n+output*3000000n;
    assert.equal(summary.cost!.amount,`${cost/1000000000000n}.${String(cost%1000000000000n).padStart(12,'0')}`); assert.equal(summary.cost!.complete,true);
    assert.equal(q.threads({},1,0).items[0].id,'huge'); assert.equal(q.allTurns({},1,0).items[0].threadId,'huge');
    assert.equal(store.one("SELECT typeof(total_tokens) type FROM usage_events WHERE event_key='huge'")!.type,'text');
    const portable=drive(store,new QueryEngine(queryStore(store.settings())).summary({threadId:'huge'}),true); assert.deepEqual(portable,summary);
  } finally { store.close(); }
});

test('SQL safety proves single values, sum bounds and cached-plus-write intermediates', () => {
  const store=new Store(':memory:');
  try {
    const safe=()=>drive(store,canAggregateInSql(queryStore(store.settings()),{sql:'',params:[]}));
    const max=9223372036854775807n;
    add(store,'one',{total_tokens:String(max),input_tokens:String(max),cached_input_tokens:'0',cache_write_input_tokens:'0'}); assert.equal(safe(),true);
    add(store,'two',{total_tokens:'1',input_tokens:'1',cached_input_tokens:'0',cache_write_input_tokens:'0'}); assert.equal(safe(),false);
    assert.equal(new Queries(store).summary().totalTokens,String(max+1n));
    store.run('DELETE FROM usage_events'); add(store,'overflow-parts',{total_tokens:'1',input_tokens:String(max),cached_input_tokens:String(max),cache_write_input_tokens:'1'});
    assert.equal(safe(),false); const result=new Queries(store).summary(); assert.equal(result.ordinaryInputTokens,null); assert.equal(result.uncachedInputTokens,'0');
    store.run('DELETE FROM usage_events'); add(store,'safe-large',{total_tokens:'9007199254740993',input_tokens:'9007199254740993'});
    assert.equal(safe(),true); assert.equal(drive(store,new QueryEngine(queryStore(store.settings())).summary(),true).totalTokens,'9007199254740993');
  } finally { store.close(); }
});

test('invalid token lexemes and unsafe numeric transports are rejected instead of rounded', () => {
  for (const bad of ['01','-1','1.2','1e20','']) {
    const store=new Store(':memory:');
    try { add(store,'bad',{total_tokens:bad}); assert.throws(()=>new Queries(store).summary(),{code:'INVALID_TOKEN_STORAGE'}); }
    finally { store.close(); }
  }
});

test('exact ratio filtering resolves a half boundary that REAL arithmetic cannot distinguish', () => {
  const store=new Store(':memory:');
  try {
    const input=9223372036854775807n,cached=input/2n;
    add(store,'below',{input_tokens:String(input),cached_input_tokens:String(cached),cache_write_input_tokens:'0',total_tokens:String(input)});
    assert.equal(new Queries(store).threads({},10,0,'tokens',0.5).total,1);
    store.run('UPDATE usage_events SET cached_input_tokens=?',[String(cached+1n)]);
    assert.equal(new Queries(store).threads({},10,0,'tokens',0.5).total,0);
  } finally { store.close(); }
});

test('tuple task-turn identities do not collide and partial token fields preserve existing null semantics', () => {
  const store=new Store(':memory:');
  try {
    add(store,'one',{thread_id:'a:b',turn_id:'c',cached_input_tokens:null,cache_write_input_tokens:null});
    add(store,'two',{thread_id:'a',turn_id:'b:c',input_tokens:null,total_tokens:null});
    const fast=new Queries(store).summary(),fallback=forcedFallback(store).summary();
    assert.equal(fast.turnCount,2); assert.equal(fast.threadCount,2); assert.equal(fast.totalTokens,'120'); assert.equal(fast.uncachedInputTokens,null); assert.deepEqual(fast,fallback);
  } finally { store.close(); }
});

test('fallback scans bounded keyset pages and returns a full page crossing aggregate block 512', () => {
  const store=new Store(':memory:');
  try {
    const count=1120,base=2n**80n;
    store.transaction(()=>{for(let i=0;i<count;i++)add(store,'thread-'+String(i).padStart(4,'0'),{total_tokens:String(base+BigInt(i)),input_tokens:String(base),cached_input_tokens:'0',cache_write_input_tokens:'0'});});
    let maximum=0,scans=0;
    const all=store.all.bind(store);
    const q=new Queries({settings:store.settings.bind(store),one:store.one.bind(store),readSnapshot:store.readSnapshot.bind(store),all<T=Record<string,any>>(sql:string,params?:SQLInputValue[]){const rows=all(sql,params);if(sql.includes('__cursor0')){maximum=Math.max(maximum,rows.length);scans++;}return rows as T[];}});
    const result=q.threads({},200,511);
    assert.equal(result.total,count); assert.equal(result.items.length,200);
    assert.deepEqual(result.items.map(r=>r.id),Array.from({length:200},(_,i)=>'thread-'+String(count-1-511-i).padStart(4,'0')));
    assert.ok(scans>=4); assert.ok(maximum<=EXACT_EVENT_PAGE_SIZE);
    assert.equal(q.threads({},10,2000).items.length,0);
  } finally { store.close(); }
});

test('cost pagination returns only page aggregates while preserving filters, null turns and JSON-safe tuple identities', () => {
  const store=new Store(':memory:');
  try {
    const unusual='task:"\\:雪';
    store.transaction(()=>{
      for(let i=0;i<1000;i++)add(store,'bulk-'+String(i).padStart(4,'0'));
      for(const [i,turn] of [null,'null','turn:"\\:雪'].entries())add(store,'special-'+i,{thread_id:unusual,turn_id:turn,total_tokens:String(900-i)});
      add(store,'excluded-model',{thread_id:unusual,turn_id:null,model:'unpriced',total_tokens:'9000'});
      add(store,'excluded-effort',{thread_id:unusual,turn_id:null,effort:'low',total_tokens:'8000'});
      add(store,'excluded-time',{thread_id:unusual,turn_id:null,at:'2025-01-01T00:00:00.000Z',total_tokens:'7000'});
    });
    store.saveSettings({...store.settings(),costEnabled:true,officialApiPricing:true,modelPrices:[{model:'priced',input:'1',cachedInput:'0.5',cacheWrite:'2',output:'3',longContextThreshold:null,longInput:null,longCachedInput:null,longCacheWrite:null,longOutput:null}]});
    let maximum=0;
    const all=store.all.bind(store),q=new Queries({settings:store.settings.bind(store),one:store.one.bind(store),readSnapshot:store.readSnapshot.bind(store),all<T=Record<string,any>>(sql:string,params?:SQLInputValue[]){const rows=all(sql,params);maximum=Math.max(maximum,rows.length);return rows as T[];}});
    const filter={model:'priced',effort:'high',from:'2026-01-01T00:00:00Z'},page=q.allTurns(filter,5,0);
    assert.equal(page.total,1003);assert.deepEqual(page.items.slice(0,3).map(row=>row.id),[null,'null','turn:"\\:雪']);
    assert.ok(page.items.every(row=>row.cost?.amount==='0.000157500000'&&row.cost.complete));
    assert.ok(maximum<=5,'no unselected turn costs should cross the query transport');
    maximum=0;
    const threads=q.threads(filter,5,1);
    assert.equal(threads.total,1001);assert.ok(threads.items.every(row=>row.cost?.amount==='0.000157500000'));
    assert.ok(maximum<=5,'no unselected thread costs should cross the query transport');
    const slow=forcedFallback(store);
    for(const sort of ['tokens','recent','oldest'])assert.deepEqual(q.allTurns({...filter,threadId:unusual},2,1,sort),slow.allTurns({...filter,threadId:unusual},2,1,sort));
    assert.equal(q.allTurns(filter,5,2000).items.length,0);assert.equal(q.threads(filter,5,2000).items.length,0);
  } finally {store.close();}
});

test('forced BigInt fallback agrees with SQL across DST, costs, searches, turns, comparisons and Agents', () => {
  const store=new Store(':memory:');
  try {
    seedExample(store); store.saveSettings({...exampleSettings(),costEnabled:true});
    add(store,'dst-first',{thread_id:'dst',at:'2026-11-01T05:30:00.000Z'}); add(store,'dst-second',{thread_id:'dst',at:'2026-11-01T06:30:00.000Z'});
    const fast=new Queries(store),slow=forcedFallback(store);
    for(const f of [{},{unknown:'model' as const},{threadId:'example-session-01'},{from:'2026-11-01T04:00:00Z',to:'2026-11-02T05:00:00Z'}]) {
      assert.deepEqual(slow.summary(f),fast.summary(f));
      for(const unit of ['day','hour'] as const)assert.deepEqual(slow.trend(f,unit),fast.trend(f,unit));
      for(const by of ['project','model','effort'] as const)assert.deepEqual(slow.groups(f,by),fast.groups(f,by));
      for(const sort of ['tokens','recent']) {
        assert.deepEqual(slow.threads(f,5,1,sort,undefined,'dashboard'),fast.threads(f,5,1,sort,undefined,'dashboard'));
        assert.deepEqual(slow.allTurns(f,7,1,sort),fast.allTurns(f,7,1,sort));
      }
    }
    assert.deepEqual(slow.agents('example-session-01'),fast.agents('example-session-01')); assert.deepEqual(slow.detail('example-session-01'),fast.detail('example-session-01'));
    const range={from:'2026-09-05T04:00:00Z',to:'2026-09-09T04:00:00Z'};assert.deepEqual(slow.compare(range,'project'),fast.compare(range,'project'));
  } finally { store.close(); }
});

async function migrationFixture(run:(file:string)=>Promise<void>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-exact-migrate-'));
  try { await run(path.join(root,'usage.sqlite')); }
  finally { const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codex-exact-migrate-'));await rm(resolved,{recursive:true,force:true}); }
}
function oldDatabase(file:string,tokenSql:string) {
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE usage_events(file TEXT NOT NULL,event_key TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,response_id TEXT,
    at TEXT NOT NULL,project TEXT,model TEXT,effort TEXT,kind TEXT NOT NULL,signature TEXT,
    ${tokenFields.map(k=>k+' INTEGER').join(',')},incomplete INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(file,event_key));
    INSERT INTO usage_events(file,event_key,thread_id,at,kind,total_tokens,active) VALUES('old','event','thread','${at}','record',${tokenSql},1);`);
  db.close();
}
test('INTEGER-to-TEXT migration preserves full int64 digits, identity, activity and indexes across restart',()=>migrationFixture(async file=>{
  oldDatabase(file,'9223372036854775807'); let store=new Store(file);
  try {
    assert.equal(store.one('SELECT typeof(total_tokens) t FROM usage_events')!.t,'text');assert.equal(new Queries(store).summary().totalTokens,'9223372036854775807');
    assert.equal(store.one("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND tbl_name='usage_events'")!.n,9n);
    store.close();store=new Store(file);assert.equal(new Queries(store).summary().eventCount,1);
    add(store,'new',{total_tokens:String(2n**127n)});assert.equal(new Queries(store).summary().totalTokens,String(2n**127n+9223372036854775807n));
  } finally {store.close();}
}));
test('migration refuses rounded REAL and preserves the old row for source-based recovery',()=>migrationFixture(async file=>{
  oldDatabase(file,'1e30');assert.throws(()=>new Store(file),{code:'TOKEN_TEXT_MIGRATION_REQUIRED'});
  const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare('SELECT typeof(total_tokens) t FROM usage_events').get()!.t,'real');assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get()!.n,1);}finally{db.close();}
}));
