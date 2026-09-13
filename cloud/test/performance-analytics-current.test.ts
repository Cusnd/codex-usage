import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { domain } from '../../modules/sync/publication/store.js';
import { createRead } from '../../modules/sync/reads/snapshots.js';
import { QueryEngine, queryStore, type Statement } from '../../modules/analytics/query-engine.js';
import { numericEvents } from '../../modules/analytics/exact-query-engine.js';
import { executeV3Query } from '../../modules/analytics/worker/executor.js';

// Replay the original trend SQL shape against the same immutable lease. This
// comparison measures join/index selection; expected values below are separate.
function* originalBucketSql<T>(query: Generator<Statement, T, any>): Generator<Statement, T, any> {
  let step = query.next();
  while (!step.done) {
    const statement = step.value;
    const source = `${numericEvents} numeric_events`;
    const sql = statement.sql.replace(`json_each(?) usage_bucket CROSS JOIN ${source}`, `${source} JOIN json_each(?) usage_bucket`).replace(/\+at ([<>]=?)/g, 'at $1');
    step = query.next(yield { ...statement, sql });
  }
  return step.value;
}

function trace(db: D1Database) {
  let rowsRead = 0;
  const plans: unknown[] = [];
  const statement = (target: D1PreparedStatement, sql: string, params: unknown[] = []): D1PreparedStatement => new Proxy(target, { get(target, key) {
    if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args), sql, args);
    if (key === 'all') return async () => {
      const started = performance.now(), result = await target.all(), ms = performance.now() - started;
      rowsRead += result.meta.rows_read;
      if (sql.includes('usage_bucket')) {
        const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all();
        plans.push({ sql, params, ms, rowsRead: result.meta.rows_read, plan: plan.results });
      }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    db: new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql), sql);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }),
    result: () => ({ rowsRead, plans }),
  };
}

it('D1 multi-day hourly and daily trends keep exact DST outputs and bounded reads with and without date filters', async ({ annotate }) => {
  const user = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user, user, 'analytics-performance', Date.now()).run();
  const h = await domain(env.DB, user);
  await env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(user).run();
  // 30 events per UTC hour for 14 days, crossing the New York spring DST gap.
  await env.DB.prepare(`WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<10079)
    INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,at,payload)
    SELECT ?,?,'event','event-'||printf('%06d',v),1,1,'fixture','thread-'||(v%30),strftime('%Y-%m-%dT%H:%M:%fZ','2026-03-01T00:30:00Z',(v/30)||' hours'),
      json_object('turn_id','turn-'||v,'model','priced','effort','high','kind','record','service_tier','standard','service_tier_source','record',
        'input_tokens','80','cached_input_tokens','20','cache_write_input_tokens','0','output_tokens','20','reasoning_output_tokens','0','total_tokens','100','incomplete',0) FROM n`).bind(user, h.active_epoch).run();
  const lease = await createRead(env.DB, user, 'full', []);
  const settings = { localInterval: 0, accountInterval: 0, timezone: 'America/New_York', timezoneMode: 'manual' as const, costEnabled: true, officialApiPricing: true,
    modelPrices: [{ model: 'priced', input: '1', cachedInput: '0.5', cacheWrite: '2', output: '3', longContextThreshold: null, longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null }] };
  const samples: unknown[] = [];
  for (const filtered of [false, true]) for (const unit of ['day', 'hour'] as const) {
    const filter = filtered ? { from: '2026-03-06T00:00:00Z', to: '2026-03-13T00:00:00Z' } : {};
    const before = trace(env.DB), after = trace(env.DB);
    const previous = await executeV3Query(before.db, user, lease.lease_id, originalBucketSql(new QueryEngine(queryStore(settings)).trend(filter, unit)));
    const current = await executeV3Query(after.db, user, lease.lease_id, new QueryEngine(queryStore(settings)).trend(filter, unit));
    expect(current).toEqual(previous);
    expect(current.reduce((sum, row) => sum + BigInt(row.totalTokens!), 0n)).toBe(filtered ? 504000n : 1008000n);
    expect(current.every(row => row.cost?.complete && row.threadCount === 30)).toBe(true);
    if (unit === 'hour') {
      expect(current).toHaveLength(filtered ? 168 : 336);
      expect(current.every(row => row.eventCount === 30 && row.totalTokens === '3000' && row.cost?.amount === '0.003900000000')).toBe(true);
      expect(current.find(row => row.time === '2026-03-08T01:00:00.000-05:00')).toBeDefined();
      expect(current.find(row => row.time === '2026-03-08T03:00:00.000-04:00')).toBeDefined();
      expect(current.some(row => row.time.startsWith('2026-03-08T02:'))).toBe(false);
    } else {
      expect(current.find(row => row.time === '2026-03-08')).toMatchObject({ eventCount: 690, totalTokens: '69000', cost: { amount: '0.089700000000' } });
      if (filtered) expect(current.map(row => [row.time, row.eventCount])).toEqual([
        ['2026-03-05', 150], ['2026-03-06', 720], ['2026-03-07', 720], ['2026-03-08', 690],
        ['2026-03-09', 720], ['2026-03-10', 720], ['2026-03-11', 720], ['2026-03-12', 600],
      ]);
    }
    const original = before.result(), optimized = after.result();
    samples.push({ filtered, unit, before: original, after: optimized });
    expect(optimized.rowsRead, `${unit} filtered=${filtered} must remain linear at the D1 transport boundary`).toBeLessThan(1_500_000);
    expect(optimized.rowsRead, `${unit} filtered=${filtered} must not regress against the original SQL shape`).toBeLessThanOrEqual(original.rowsRead * 1.1 + 1000);
  }
  // Keep routine CI diagnostics compact; JSON bucket parameters can dominate logs.
  const evidence = JSON.stringify({ events: 10080, samples }, (key, value) =>
    key === 'sql' || key === 'params' ? undefined : key === 'plan' ? value.map((row: { detail: string }) => row.detail) : value);
  await annotate(evidence, 'performance');
}, 60000);
