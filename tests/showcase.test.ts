import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { Store } from '../modules/storage/sqlite.js';
import { Queries } from '../modules/analytics/sqlite.js';
import { ExampleStore, exampleSettings } from '../apps/showcase/store.js';
import { seedExample, EXAMPLE_NOW } from '../apps/showcase/fixture.js';
import { createExampleAdapter } from '../apps/showcase/adapter.js';
import type { Filter } from '../modules/contracts/query.js';

test('browser SQLite and native queries agree across scopes, costs, pages, missing fields and integer precision', async () => {
  const native = new Store(':memory:');
  const browser = new ExampleStore(await initSqlJs());
  try {
    seedExample(native);
    native.saveSettings(exampleSettings());
    const a = new Queries(native), b = new Queries(browser);
    assert.equal(b.summary().totalTokens, '119210000');
    assert.equal(b.summary().turnCount, 92);
    const filters: Filter[] = [{}, {from:'2026-09-05T04:00:00Z',to:'2026-09-06T04:00:00Z'},
      {project:'c:\\design\\codex-usage',model:'gpt-6-astra',effort:'high'}, {unknown:'model'},
      {from:EXAMPLE_NOW,to:'2026-09-09T04:00:00Z'}, {threadId:'example-session-01'}];
    for (const costEnabled of [false,true]) for (const timezone of ['America/New_York','Asia/Shanghai','UTC']) {
      const settings = {...exampleSettings(), costEnabled, timezone};
      native.saveSettings(settings); browser.saveSettings(settings);
      for (const f of filters) {
        assert.deepEqual(b.summary(f), a.summary(f));
        assert.deepEqual(b.filters(f), a.filters(f));
        for (const bucket of ['day','hour'] as const) assert.deepEqual(b.trend(f,bucket), a.trend(f,bucket));
        for (const by of ['project','model','effort'] as const) assert.deepEqual(b.breakdown(f,by,2,1), a.breakdown(f,by,2,1));
        for (const sort of ['tokens','recent']) for (const q of [undefined,'dashboard','no-match']) {
          assert.deepEqual(b.threads(f,3,1,sort,undefined,q),a.threads(f,3,1,sort,undefined,q));
          assert.deepEqual(b.allTurns(f,4,2,sort,q),a.allTurns(f,4,2,sort,q));
        }
        assert.deepEqual(b.agents('example-session-01',f),a.agents('example-session-01',f));
      }
    }
    assert.deepEqual(b.detail('example-session-01'),a.detail('example-session-01'));
    assert.equal(b.detail('missing-task'),null);
    assert.deepEqual(b.threads({},50,0,'tokens',0.2),a.threads({},50,0,'tokens',0.2));
    assert.deepEqual(b.compare({from:'2026-09-05T04:00:00Z',to:EXAMPLE_NOW},'project'),a.compare({from:'2026-09-05T04:00:00Z',to:EXAMPLE_NOW},'project'));
    // Values above Number.MAX_SAFE_INTEGER and genuine missing fields must stay exact.
    for (const store of [native,browser]) store.run(`UPDATE usage_events SET total_tokens=9007199254740993,
      input_tokens=9007199254740000,cached_input_tokens=NULL,cache_write_input_tokens=NULL,
      model=NULL,effort=NULL,turn_id=NULL,incomplete=1 WHERE event_key='event-0'`);
    assert.deepEqual(b.summary(),a.summary());
    assert.deepEqual(b.summary({unknown:'model'}),a.summary({unknown:'model'}));
    assert.deepEqual(b.allTurns({},50,0),a.allTurns({},50,0));
    assert.deepEqual(b.agents('example-session-01'),a.agents('example-session-01'));
  } finally {native.close();browser.close();}
});

test('example API supports navigation, fixed dates, private settings and refresh without host access', async () => {
  const SQL = await initSqlJs();
  const stores: ExampleStore[] = [];
  const values = new Map<string,string>();
  const storage = { getItem:(k:string)=>values.get(k)??null, setItem:(k:string,v:string)=>{values.set(k,v);} };
  const make = (persist = false) => { const store = new ExampleStore(SQL); stores.push(store); return createExampleAdapter(store,persist ? storage : undefined); };
  try {
    const first = make(true);
    assert.equal((await first.request('local/summary')).meta.exampleData,true);
    assert.deepEqual((await first.request('local/threads/example-session-01/agents')).data,first.queries.agents('example-session-01'));
    assert.deepEqual((await first.request('local/turns',{missingTurn:true})).data,first.queries.allTurns({turnId:null},50,0));
    await assert.rejects(first.request('local/threads/no-such-task'),/没有找到/);
    await assert.rejects(first.request('local/threads',{limit:201}),/分页/);
    await assert.rejects(first.request('local/compare',{baselineFrom:EXAMPLE_NOW}),/同时提供/);
    await assert.rejects(first.request('settings',{},'PATCH',{localInterval:5}),/至少/);
    await assert.rejects(first.request('system/autostart',{},'POST',{enabled:true}),/本地应用/);
    await first.request('settings',{},'PATCH',{costEnabled:true,timezone:'Asia/Shanghai'});
    assert.equal(make(true).store.settings().costEnabled,true);
    assert.equal(make().store.settings().costEnabled,false);
    const before = await first.request('local/summary');
    await first.request('refresh',{},'POST',{source:'all'});
    const after = await first.request('local/summary');
    assert.deepEqual(after.data,before.data); assert.notEqual(after.meta.updatedAt,before.meta.updatedAt);
    assert.deepEqual((await first.request('system/autostart')).data,{supported:false,enabled:false});
    assert.equal((await first.request('account/limits')).meta.identityConfirmed,true);
    values.set([...values.keys()][0],'{broken json');
    assert.equal(make(true).store.settings().costEnabled,false);
  } finally { stores.forEach(s=>s.close()); }
});
