import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../modules/storage/sqlite.js';
import { Queries } from '../modules/analytics/sqlite.js';

const output = path.resolve('artifacts/performance-current/analytics');
const phase = process.argv[2] ?? 'before';
const fallback = process.env.ANALYTICS_FALLBACK === '1';
const variant = fallback ? 'fallback-' : '';
const sizes = (process.env.ANALYTICS_SIZES ?? '10000,100000').split(',').map(Number);
const repeats = Number(process.env.ANALYTICS_REPEATS ?? '3');
const cases = process.env.ANALYTICS_CASES?.split(',');
mkdirSync(output, { recursive: true });
const rows: Record<string, unknown>[] = [];
for (const size of sizes) {
  const store = new Store(':memory:');
  store.saveSettings({ ...store.settings(), timezone: 'America/New_York', costEnabled: true });
  store.transaction(() => {
    for (let i = 0; i < size; i++) {
      const thread = `thread-${String(i % 1000).padStart(4, '0')}`;
      const input = 10000 + i % 10000;
      store.run(`INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,incomplete,active,service_tier,service_tier_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        'fixture', `event-${String(i).padStart(8, '0')}`, thread, i % 71 === 0 ? null : `turn-${Math.floor(i / 1000)}`, `response-${i}`,
        new Date(Date.UTC(2026, 0, 1) + Math.floor(i * 180 * 86400000 / size)).toISOString(), `/project-${i % 17}`,
        ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro'][i % 3], ['low', 'medium', 'high'][i % 3], 'record',
        String(input), String(i % 5000), i % 37 === 0 ? null : '0', '200', '50', String((fallback ? 2n ** 100n : 0n) + BigInt(input + 200)), i % 37 === 0 ? 1 : 0, 1,
        i % 2 ? 'standard' : 'fast', 'record',
      ]);
      store.run('INSERT OR IGNORE INTO threads(id,title,project) VALUES(?,?,?)', [thread, `Title ${thread}`, `/project-${i % 17}`]);
    }
  });
  const q = new Queries(store);
  const operations: Record<string, () => unknown> = {
    summary: () => q.summary({}),
    groups: () => q.groups({}, 'project'),
    threads: () => q.threads({}, 50, 0),
    turns: () => q.allTurns({}, 50, 0),
    day180: () => q.trend({}, 'day'),
    hour7: () => q.trend({ from: '2026-03-06T00:00:00Z', to: '2026-03-13T00:00:00Z' }, 'hour'),
    hour180: () => q.trend({}, 'hour'),
  };
  for (const [name, fn] of Object.entries(operations)) {
    if (cases && !cases.includes(name)) continue;
    const file = path.join(output, `${variant}${size}-${name}`);
    const statements: { ms: number; sql: string; params: unknown[]; plan: unknown[] }[] = [];
    const all = store.all.bind(store), one = store.one.bind(store);
    function record(sql: string, params: any[] = [], single = false) {
      const started = performance.now(), result = single ? one(sql, params) : all(sql, params);
      statements.push({ ms: performance.now() - started, sql, params, plan: all(`EXPLAIN QUERY PLAN ${sql}`, params) });
      return result;
    }
    store.all = ((sql: string, params?: any[]) => record(sql, params)) as typeof store.all;
    store.one = ((sql: string, params?: any[]) => record(sql, params, true)) as typeof store.one;
    const initial = fn();
    store.all = all; store.one = one;
    const encoded = JSON.stringify(initial);
    if (phase === 'before') writeFileSync(`${file}-output.json`, encoded);
    else assert.deepEqual(initial, JSON.parse(readFileSync(`${file}-output.json`, 'utf8')), `${size} ${name} complete output equivalence`);
    const times: number[] = [];
    for (let r = 0; r < repeats; r++) {
      const started = performance.now(); const result = fn(); times.push(performance.now() - started);
      assert.deepEqual(result, initial);
    }
    times.sort((a, b) => a - b);
    const result = { size, name, fallback, times, medianMs: times[Math.floor(times.length / 2)], outputBytes: encoded.length, sha256: createHash('sha256').update(encoded).digest('hex') };
    rows.push(result); console.log(JSON.stringify(result));
    writeFileSync(`${file}-${phase}-statements.json`, JSON.stringify(statements, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    writeFileSync(path.join(output, `${variant}${phase}.json`), JSON.stringify({ node: process.version, platform: process.platform, repeats, rows }, null, 2));
  }
  store.close();
}
