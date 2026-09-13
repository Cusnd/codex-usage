import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { Store } from '../modules/storage/sqlite.js';
import { ExampleStore } from '../apps/showcase/store.js';
import { Queries } from '../modules/analytics/sqlite.js';
import type { SQLInputValue } from '../modules/analytics/plan.js';

function add(store: Store | ExampleStore, key: string, values: Record<string, string | number | null> = {}) {
  const row = { file: 'fixture', event_key: key, thread_id: key, turn_id: 'turn', response_id: key,
    at: '2026-11-01T05:30:00.000Z', project: '/selected', model: 'priced', effort: 'high', kind: 'record',
    input_tokens: '100', cached_input_tokens: '25', cache_write_input_tokens: '0', output_tokens: '20',
    reasoning_output_tokens: '5', total_tokens: '120', active: 1, incomplete: 0,
    service_tier: 'standard', service_tier_source: 'record', ...values };
  store.run(`INSERT INTO usage_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
  store.run('INSERT OR IGNORE INTO threads(id,title,project) VALUES(?,?,?)', [row.thread_id, `Title ${row.thread_id}`, row.project]);
}

function forcedFallback(store: Store | ExampleStore) {
  return new Queries({ all: store.all.bind(store), settings: store.settings.bind(store),
    one(sql: string, params?: SQLInputValue[]) {
      const row = store.one(sql, params);
      return sql.includes('total_tokens_digits') ? { ...row, total_tokens_digits: 40 } : row;
    } });
}

test('paged compositions preserve complete tuple identities, null turns, filters and exact costs in native and browser SQLite', async () => {
  const stores = [new Store(':memory:'), new ExampleStore(await initSqlJs())];
  try {
    for (const store of stores) {
      store.run('DELETE FROM usage_events'); store.run('DELETE FROM threads');
      store.saveSettings({ ...store.settings(), costEnabled: true, officialApiPricing: true,
        modelPrices: [{ model: 'priced', input: '1', cachedInput: '0.5', cacheWrite: '2', output: '3',
          longContextThreshold: null, longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null }] });
      const tuples: [string, string | null][] = [['a:b', 'c'], ['a', 'b:c'], ['雪"\\', null], ['雪"\\', 'null'], ['雪"\\', '"null"']];
      for (const [index, [thread_id, turn_id]] of tuples.entries()) {
        add(store, `selected-${index}`, { thread_id, turn_id, total_tokens: String(200 - index) });
        add(store, `other-model-${index}`, { thread_id, turn_id, model: 'excluded', total_tokens: '5000' });
        add(store, `other-date-${index}`, { thread_id, turn_id, at: '2025-01-01T00:00:00.000Z', total_tokens: '6000' });
      }
      add(store, 'other-project', { project: '/excluded', total_tokens: '9000' });
      const filter = { from: '2026-01-01T00:00:00Z', model: 'priced', project: '/selected' };
      for (const queries of [new Queries(store), forcedFallback(store)]) {
        const page = queries.allTurns(filter, 3, 1);
        assert.equal(page.total, 5);
        assert.deepEqual(page.items.map(row => [row.threadId, row.id, row.totalTokens]), [['a', 'b:c', '199'], ['雪"\\', null, '198'], ['雪"\\', 'null', '197']]);
        for (const row of page.items) {
          assert.equal(row.eventCount, 1); assert.equal(row.cost?.amount, '0.000147500000');
          assert.equal(row.cost?.complete, true); assert.equal(row.composition.length, 1);
          assert.equal(row.composition[0].totalTokens, row.totalTokens);
          assert.equal(row.composition[0].model, 'priced');
        }
        assert.equal(queries.threads(filter, 1, 1).total, 3);
        assert.equal(queries.allTurns(filter, 3, 5).items.length, 0);
      }
    }
  } finally { stores.forEach(store => store.close()); }
});

test('filtered trend retains both DST overlap hours and quarter-hour timezone boundaries in both exact paths', () => {
  const store = new Store(':memory:');
  try {
    const dates = ['2026-11-01T05:00:00.000Z', '2026-11-01T05:59:59.999Z', '2026-11-01T06:00:00.000Z', '2026-11-01T06:59:59.999Z'];
    dates.forEach((at, index) => add(store, `dst-${index}`, { at }));
    add(store, 'outside', { at: '2026-11-01T07:00:00.000Z' });
    const filter = { from: '2026-11-01T05:00:00Z', to: '2026-11-01T07:00:00Z' };
    for (const queries of [new Queries(store), forcedFallback(store)]) {
      assert.deepEqual(queries.trend(filter, 'hour').map(row => [row.time, row.totalTokens]), [
        ['2026-11-01T01:00:00.000-04:00', '240'], ['2026-11-01T01:00:00.000-05:00', '240'],
      ]);
      assert.deepEqual(queries.trend(filter, 'day').map(row => [row.time, row.totalTokens]), [['2026-11-01', '480']]);
    }
    store.saveSettings({ ...store.settings(), timezone: 'Asia/Kathmandu' });
    for (const queries of [new Queries(store), forcedFallback(store)]) {
      assert.deepEqual(queries.trend(filter, 'hour').map(row => [row.time, row.totalTokens]), [
        ['2026-11-01T10:00:00.000+05:45', '120'], ['2026-11-01T11:00:00.000+05:45', '240'], ['2026-11-01T12:00:00.000+05:45', '120'],
      ]);
    }
  } finally { store.close(); }
});
