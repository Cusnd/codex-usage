import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { Store } from '../modules/storage/sqlite.js';
import { Queries, type QueryOperation, type SynchronousQueryExecutor } from '../modules/analytics/sqlite.js';
import { QueryEngine, queryStore, type QueryEngineOptions, type Statement } from '../modules/analytics/query-engine.js';
import { OverviewSchema } from '../modules/contracts/query.js';
import { MetaSchema } from '../modules/contracts/responses.js';
import type { QueryFilter } from '../modules/analytics/filter.js';

function add(store: Store, id: string, values: Record<string, unknown> = {}) {
  const row = { file: 'fixture', event_key: id, thread_id: id, turn_id: 'turn', response_id: id,
    at: '2026-11-01T05:30:00.000Z', project: 'project', model: 'priced', effort: 'high', kind: 'record',
    input_tokens: '100', cached_input_tokens: '25', cache_write_input_tokens: '10', output_tokens: '20',
    reasoning_output_tokens: '5', total_tokens: '120', incomplete: 0, excluded: 0, active: 1,
    service_tier: 'standard', service_tier_source: 'record', ...values };
  store.run(`INSERT INTO usage_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`, Object.values(row) as any[]);
  store.run('INSERT OR IGNORE INTO threads(id,title,project) VALUES(?,?,?)', [row.thread_id as string, 'Title ' + row.thread_id, row.project as string | null]);
}
function kinds(store: Store): QueryEngineOptions {
  store.run('CREATE TABLE fixture_kinds(project TEXT PRIMARY KEY, kind TEXT NOT NULL, cut INTEGER NOT NULL)');
  for (const [id, kind] of [['project', 'project'], ['session:actually-project', 'project'], ["chat'quoted", 'session'], ['unknown-source', 'unknown']]) {
    store.run('INSERT INTO fixture_kinds VALUES(?,?,?)', [id, kind, 3]);
  }
  return { projectKinds: () => ({ sql: 'SELECT project,kind FROM fixture_kinds WHERE cut=?', params: [3] }) };
}
function drive<T>(store: SynchronousQueryExecutor, query: Generator<Statement, T, any>) {
  let next = query.next();
  while (!next.done) { const s = next.value; next = query.next(s.one ? store.one(s.sql, s.params) : store.all(s.sql, s.params)); }
  return next.value;
}

test('overview returns compact distinct identities and shares one proof and observed coverage with trend', () => {
  const store = new Store(':memory:');
  try {
    const options = kinds(store), statements: string[] = [];
    add(store, 'old-chat', { thread_id: 'shared-chat', project: "chat'quoted", at: '2020-01-01T00:00:00.000Z' });
    add(store, 'new-chat', { thread_id: 'shared-chat', project: "chat'quoted" });
    add(store, 'project-a'); add(store, 'project-b');
    add(store, 'named-like-session', { project: 'session:actually-project' });
    add(store, 'unknown', { project: 'unknown-source' }); add(store, 'missing', { project: null });
    const normal = new Queries(store, options);
    const tracked: SynchronousQueryExecutor = { settings: () => store.settings(), readSnapshot: read => store.readSnapshot(read),
      one: (sql, params) => { statements.push(sql); return store.one(sql, params); },
      all: (sql, params) => { statements.push(sql); return store.all(sql, params); } };
    const f = { to: '2026-11-02T00:00:00.000Z' };
    const actual = new Queries(tracked, options).overview(f);
    assert.equal(Value.Check(OverviewSchema, actual), true);
    assert.deepEqual(actual.metrics, normal.summary(f));
    assert.deepEqual(actual.trend, normal.trend(f, 'month'));
    assert.deepEqual(actual.scope, { firstAt: '2020-01-01T00:00:00.000Z', lastAt: '2026-11-01T05:30:00.000Z', projectCount: 2, projectlessChatCount: 1, unresolvedChatCount: 2 });
    assert.equal(actual.bucket, 'month');
    assert.equal(statements.filter(sql => sql.includes('total_tokens_digits')).length, 1);
    assert.equal(statements.filter(sql => sql.includes('SELECT MIN(at) lo,MAX(at) hi')).length, 0);
    assert.equal(statements.length, 3, 'proof+scope, metrics and trend each execute once');
    assert.deepEqual(normal.scopeSummary(f), actual.scope);
    const selected = normal.overview({ ...f, project: "chat'quoted", from: '2026-10-31T00:00:00.000Z' }, 'hour');
    assert.equal(selected.scope.projectCount, 0); assert.equal(selected.scope.projectlessChatCount, 1);
    assert.equal(selected.metrics.totalTokens, '120');
    assert.deepEqual(selected.trend, normal.trend({ ...f, project: "chat'quoted", from: '2026-10-31T00:00:00.000Z' }, 'hour'));
  } finally { store.close(); }
});

test('overview preserves BigInt, null, cost and DST semantics while an empty scope remains empty', () => {
  const store = new Store(':memory:');
  try {
    const options = kinds(store), huge = 2n ** 120n;
    store.saveSettings({ ...store.settings(), timezone: 'America/New_York', costEnabled: true, officialApiPricing: true,
      modelPrices: [{ model: 'priced', input: '1', cachedInput: '0.5', cacheWrite: '2', output: '3', longContextThreshold: null, longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null }] });
    add(store, 'huge', { thread_id: 'shared', project: "chat'quoted", input_tokens: String(huge), total_tokens: String(huge + 20n) });
    add(store, 'fall-back-hour', { thread_id: 'shared', project: "chat'quoted", at: '2026-11-01T06:30:00.000Z', cache_write_input_tokens: null });
    const q = new Queries(store, options), f = { from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' };
    const actual = q.overview(f);
    assert.equal(actual.bucket, 'hour'); assert.equal(actual.trend.length, 2);
    assert.deepEqual(actual.metrics, q.summary(f)); assert.deepEqual(actual.trend, q.trend(f, 'hour'));
    assert.equal(actual.metrics.totalTokens, String(huge + 140n));
    assert.equal(actual.metrics.ordinaryInputTokens, null); assert.equal(actual.scope.projectlessChatCount, 1);
    assert.ok(actual.metrics.cost?.amount); assert.equal(actual.metrics.cost?.complete, false);
    const empty = q.overview({ ...f, model: 'missing' });
    assert.deepEqual(empty.scope, { firstAt: null, lastAt: null, projectCount: 0, projectlessChatCount: 0, unresolvedChatCount: 0 });
    assert.equal(empty.metrics.totalTokens, '0'); assert.deepEqual(empty.trend, []);
    assert.equal(Value.Check(OverviewSchema, empty), true);
    const engine = new QueryEngine(queryStore(store.settings()), options);
    const alreadyProven = drive(store, engine.summary(f));
    const reused = drive(store, engine.overview(f, 'day'));
    assert.deepEqual(reused.metrics, alreadyProven);
    assert.deepEqual(reused.scope, actual.scope);
  } finally { store.close(); }
});

test('compact scope avoids token work, while overview still rejects invalid token storage', () => {
  const store = new Store(':memory:');
  try {
    const options = kinds(store);
    add(store, 'bad', { total_tokens: '1e10' });
    assert.deepEqual(new Queries(store, options).scopeSummary(), { firstAt: '2026-11-01T05:30:00.000Z', lastAt: '2026-11-01T05:30:00.000Z', projectCount: 1, projectlessChatCount: 0, unresolvedChatCount: 0 });
    assert.throws(() => new Queries(store, options).overview(), { code: 'INVALID_TOKEN_STORAGE' });
  } finally { store.close(); }
});

test('request-aware executors run inside their snapshot and filter options can omit the directory query', () => {
  const store = new Store(':memory:');
  try {
    add(store, 'first'); add(store, 'second', { project: null, model: null, effort: null });
    const selected: { filter: QueryFilter; operation: QueryOperation }[] = [], statements: string[] = [];
    let inSnapshot = false;
    const executor: SynchronousQueryExecutor = {
      settings: () => { assert.equal(inSnapshot, true); return store.settings(); },
      all: (sql, params) => { assert.equal(inSnapshot, true); statements.push(sql); return store.all(sql, params); },
      one: (sql, params) => { assert.equal(inSnapshot, true); statements.push(sql); return store.one(sql, params); },
      readSnapshot: read => store.readSnapshot(() => { inSnapshot = true; try { return read(); } finally { inSnapshot = false; } }),
    };
    const unavailable = () => { throw Error('Unplanned executor was used'); };
    const q = new Queries({ settings: unavailable, all: unavailable, one: unavailable,
      forQuery: (filter, operation) => { selected.push({ filter, operation }); return executor; } });
    assert.deepEqual(q.filters({}, { projects: false }), { projects: [], models: [null, 'priced'], efforts: [null, 'high'] });
    assert.equal(statements.length, 2); assert.ok(statements.every(sql => !sql.includes('DISTINCT project')));
    assert.deepEqual(selected, [{ filter: {}, operation: 'filters' }]);
    assert.equal(q.detail('first')?.thread.totalTokens, '120');
    assert.deepEqual(selected.at(-1), { filter: { threadId: 'first' }, operation: 'detail' });
    assert.equal(Value.Check(MetaSchema, { source: 'local', updatedAt: null, timezone: 'UTC', warnings: [], projectLabels: [{ id: 'chat', name: 'Session title', kind: 'session' }] }), true);
  } finally { store.close(); }
});
