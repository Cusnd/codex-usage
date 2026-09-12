import { DateTime } from 'luxon';
import type { Settings } from '../contracts/settings.js';
import { estimateCost, pricingCatalog } from '../settings/pricing.js';
import { tokenFields } from '../foundation/query-values.js';
import type { QueryStore, SQLInputValue, Statement } from './plan.js';

export const EXACT_EVENT_PAGE_SIZE = 512;
const I64_MAX = 9223372036854775807n;
export type SqlWhere = { sql: string; params: SQLInputValue[] };
export type BucketPlan = { expression: string; join: string; params: SQLInputValue[] };
export type AggregateRow = Record<string, any>;
const metadata = ['event_key', 'thread_id', 'turn_id', 'at', 'project', 'model', 'effort', 'kind', 'incomplete', 'service_tier', 'service_tier_source'];
export const numericEvents = `(SELECT ${metadata.join(',')},${tokenFields.map(k => `CAST(${k} AS INTEGER) ${k}`).join(',')} FROM effective_events)`;
const exactText = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Unsafe numeric value reached the exact query engine');
    return String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid exact integer text');
  return value;
};
export const exactInteger = (value: unknown): bigint | null => value == null ? null : BigInt(exactText(value));
const numericColumns = [...tokenFields, 'uncached_input', 'ordinary_input', 'paired_input', 'paired_cached'];
export function bigintMetrics(row: AggregateRow): AggregateRow {
  const result = { ...row };
  for (const key of numericColumns) if (Object.hasOwn(result, key)) result[key] = exactInteger(result[key]);
  return result;
}

/** Reject noncanonical token values before selecting an exact aggregation path. */
export const invalidTokenStorageSql = tokenFields.map(k => `(${k} IS NOT NULL AND (typeof(${k}) NOT IN ('integer','text') OR NOT (CAST(${k} AS TEXT)='0' OR (substr(CAST(${k} AS TEXT),1,1) BETWEEN '1' AND '9' AND CAST(${k} AS TEXT) NOT GLOB '*[^0-9]*'))))`).join(' OR ');

export function* canAggregateInSql(store: QueryStore, where: SqlWhere): Generator<Statement, boolean, any> {
  // A non-flattened, streaming projection evaluates JSON-backed token columns once
  // per filtered row. LIMIT -1 preserves every row while retaining filter indexes;
  // the outer proof still validates storage and every exact integer bound.
  const row = (yield* store.one(`SELECT CAST(COUNT(*) AS TEXT) n,COALESCE(MAX(CASE WHEN ${invalidTokenStorageSql} THEN 1 ELSE 0 END),0) invalid,
    ${tokenFields.map(k => `MAX(length(CAST(${k} AS TEXT))) ${k}_digits,MAX(CASE WHEN length(CAST(${k} AS TEXT))<=19 THEN printf('%019s',CAST(${k} AS TEXT)) END) ${k}_max`).join(',')}
    FROM (SELECT ${tokenFields.join(',')} FROM effective_events ${where.sql} LIMIT -1) checked`, where.params))!;
  if (Number(row.invalid)) throw Object.assign(new Error('Token storage contains a noncanonical value or a previously rounded REAL; exact statistics require reimporting that source.'), { code: 'INVALID_TOKEN_STORAGE' });
  const n = BigInt(exactText(row.n)), maxima = new Map<string, bigint>();
  for (const k of tokenFields) {
    if (Number(row[k + '_digits'] ?? 0) > 19) return false;
    const value = row[k + '_max'] == null ? 0n : BigInt(String(row[k + '_max']).trim());
    if (value > I64_MAX || n * value > I64_MAX) return false;
    maxima.set(k, value);
  }
  // SQL evaluates cached+write before comparing it with input, even when its result is invalid usage.
  if (maxima.get('cached_input_tokens')! + maxima.get('cache_write_input_tokens')! > I64_MAX) return false;
  return true;
}

export function* timeBucketPlan(store: QueryStore, where: SqlWhere, unit: 'hour' | 'day'): Generator<Statement, BucketPlan, any> {
  const range = (yield* store.one(`SELECT MIN(at) lo,MAX(at) hi FROM effective_events ${where.sql}`, where.params))!;
  const buckets: { s: string; e: string; label: string }[] = [];
  if (range.lo != null) {
    const zone = store.settings().timezone;
    let at = DateTime.fromISO(range.lo, { zone: 'utc' }).setZone(zone).startOf(unit);
    const stop = Date.parse(range.hi);
    if (!at.isValid) throw new Error('Invalid timezone or timestamp');
    while (at.toMillis() <= stop) {
      const end = at.plus(unit === 'hour' ? { hours: 1 } : { days: 1 });
      buckets.push({ s: at.toUTC().toISO()!, e: end.toUTC().toISO()!, label: unit === 'hour' ? at.toISO()! : at.toISODate()! }); at = end;
      if (buckets.length > 20000) throw Object.assign(new Error('Please narrow the hourly trend range or use daily buckets.'), { code: 'RANGE_TOO_WIDE' });
    }
  }
  return { expression: "json_extract(usage_bucket.value,'$.label')", join: "JOIN json_each(?) usage_bucket ON at>=json_extract(usage_bucket.value,'$.s') AND at<json_extract(usage_bucket.value,'$.e')", params: [JSON.stringify(buckets)] };
}

type Accumulator = {
  row: AggregateRow;
  sums: (bigint | null)[];
  uncached: bigint; ordinary: bigint; uncachedValid: boolean; ordinaryValid: boolean;
  pairedInput: bigint | null; pairedCached: bigint | null;
  previousThread: string | undefined; previousTurn: string | undefined;
  costGroups: Map<string, Accumulator> | null;
};
function accumulator(costs: boolean): Accumulator {
  return { row: { event_count: 0, thread_count: 0, turn_count: 0, incomplete_events: 0, write_missing: 0, missing_write: 0, missing_usage: 0, invalid_usage: 0, compat_events: 0, first_at: null, last_at: null, project: null },
    sums: tokenFields.map(() => null), uncached: 0n, ordinary: 0n, uncachedValid: true, ordinaryValid: true,
    pairedInput: null, pairedCached: null, previousThread: undefined, previousTurn: undefined, costGroups: costs ? new Map() : null };
}
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  // SQLite BINARY follows UTF-8/code point order, which differs from JS UTF-16 for supplementary characters.
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (d) return d < 0 ? -1 : 1; }
  return x.length < y.length ? -1 : 1;
}
export function compareNullable(a: string | null, b: string | null): number { return a === b ? 0 : a === null ? -1 : b === null ? 1 : compareText(a, b); }
function add(acc: Accumulator, event: AggregateRow, settings: Settings, prices: Map<string, NonNullable<Settings['modelPrices']>[number]>): void {
  const r = acc.row, values = tokenFields.map(k => exactInteger(event[k]));
  r.event_count++; r.incomplete_events += Number(event.incomplete || 0);
  for (let i = 0; i < values.length; i++) if (values[i] !== null) acc.sums[i] = (acc.sums[i] ?? 0n) + values[i]!;
  const [input, cached, write, output] = values;
  if (input !== null && cached !== null && input >= cached) {
    acc.uncached += input - cached; acc.pairedInput = (acc.pairedInput ?? 0n) + input; acc.pairedCached = (acc.pairedCached ?? 0n) + cached;
  } else acc.uncachedValid = false;
  if (input !== null && cached !== null && write !== null && input >= cached + write) acc.ordinary += input - cached - write;
  else acc.ordinaryValid = false;
  if (write === null) { r.write_missing++; r.missing_write++; }
  if (input === null || cached === null || output === null) r.missing_usage++;
  if (input !== null && cached !== null && input < cached + (write ?? 0n)) r.invalid_usage++;
  if (event.kind !== 'record') r.compat_events++;
  if (r.first_at === null || event.at < r.first_at) r.first_at = event.at;
  if (r.last_at === null || event.at > r.last_at) r.last_at = event.at;
  if (event.project !== null && (r.project === null || compareText(event.project, r.project) < 0)) r.project = event.project;
  if (acc.previousThread !== event.thread_id) { r.thread_count++; acc.previousThread = event.thread_id; }
  const turn = JSON.stringify([event.thread_id, event.turn_id]);
  if (event.turn_id !== null && acc.previousTurn !== turn) r.turn_count++;
  acc.previousTurn = turn;
  if (acc.costGroups) {
    const price = prices.get(event.model), threshold = price?.longContextThreshold;
    const long = threshold != null && input != null && input > BigInt(threshold) ? 1 : 0;
    const tier = event.service_tier ?? 'unknown', source = event.service_tier_source ?? 'unknown';
    const key = JSON.stringify([event.model, long, tier, source]);
    let group = acc.costGroups.get(key);
    if (!group) { group = accumulator(false); group.row.model = event.model; group.row.long_context = long; group.row.service_tier = tier; group.row.service_tier_source = source; acc.costGroups.set(key, group); }
    add(group, event, settings, prices);
  }
}
function finish(acc: Accumulator, settings: Settings): AggregateRow {
  const r = { ...acc.row };
  tokenFields.forEach((k, i) => r[k] = acc.sums[i]);
  r.uncached_input = acc.uncachedValid ? acc.uncached : null; r.ordinary_input = acc.ordinaryValid ? acc.ordinary : null;
  r.paired_input = acc.pairedInput; r.paired_cached = acc.pairedCached;
  if (acc.costGroups) r.cost = estimateCost([...acc.costGroups.values()].sort((a,b)=>compareNullable(a.row.model,b.row.model)||a.row.long_context-b.row.long_context||compareNullable(a.row.service_tier,b.row.service_tier)||compareNullable(a.row.service_tier_source,b.row.service_tier_source)).map(group => finish(group, settings)), settings);
  return r;
}

/** Stream one ordered group at a time. Only a page of raw events and the current aggregate are retained. */
export function* scanAggregates(store: QueryStore, where: SqlWhere, expressions: string[], consume: (row: AggregateRow) => void, bucket?: BucketPlan): Generator<Statement, number, any> {
  const settings = store.settings(), prices = new Map(pricingCatalog(settings).map(p => [p.model, p]));
  const order = [...new Set([...expressions, 'thread_id', 'turn_id', 'event_key'])];
  let cursor: (string | null)[] | null = null, current: Accumulator | null = null, groupKey: string | null = null, groups = 0;
  for (;;) {
    const conditions: string[] = [], cursorParams: SQLInputValue[] = [];
    if (cursor) for (let i = 0; i < order.length; i++) {
      const and: string[] = [];
      for (let j = 0; j < i; j++) { and.push(`${order[j]} IS ?`); cursorParams.push(cursor[j]); }
      if (cursor[i] === null) and.push(`${order[i]} IS NOT NULL`);
      else { and.push(`${order[i]} > ?`); cursorParams.push(cursor[i]); }
      conditions.push('(' + and.join(' AND ') + ')');
    }
    const sqlWhere = where.sql + (conditions.length ? `${where.sql ? ' AND' : 'WHERE'} (${conditions.join(' OR ')})` : '');
    const rows = yield* store.all(`SELECT ${metadata.join(',')},${tokenFields.map(k => `CAST(${k} AS TEXT) ${k}`).join(',')}${expressions.map((e, i) => `,${e} __g${i}`).join('')}${order.map((e, i) => `,${e} __cursor${i}`).join('')}
      FROM effective_events ${bucket?.join ?? ''} ${sqlWhere} ORDER BY ${order.join(',')} LIMIT ?`, [...(bucket?.params ?? []), ...where.params, ...cursorParams, EXACT_EVENT_PAGE_SIZE]);
    if (!rows.length) break;
    for (const row of rows) {
      const key = JSON.stringify(expressions.map((_, i) => row['__g' + i] ?? null));
      if (key !== groupKey) {
        if (current) { consume(finish(current, settings)); groups++; }
        current = accumulator(!!settings.costEnabled); expressions.forEach((_, i) => current!.row['k' + i] = row['__g' + i] ?? null); groupKey = key;
      }
      add(current!, row, settings, prices);
    }
    cursor = order.map((_, i) => rows.at(-1)!['__cursor' + i] ?? null);
    if (rows.length < EXACT_EVENT_PAGE_SIZE) break;
  }
  if (current) { consume(finish(current, settings)); groups++; }
  else if (!expressions.length) { consume(finish(accumulator(!!settings.costEnabled), settings)); groups++; }
  return groups;
}

function decimalFraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid ratio filter');
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e'), [whole, fraction = ''] = coefficient.split('.');
  const power = Number(exponent) - fraction.length, numerator = BigInt(whole + fraction);
  return power >= 0 ? [numerator * 10n ** BigInt(power), 1n] : [numerator, 10n ** BigInt(-power)];
}
export function cacheBelowExact(row: AggregateRow, threshold: number): boolean {
  const input = exactInteger(row.paired_input), cached = exactInteger(row.paired_cached);
  if (input === null || cached === null || input <= 0n) return false;
  const [n, d] = decimalFraction(threshold); return cached * d < input * n;
}
export function compareAggregate(a: AggregateRow, b: AggregateRow, sort: string, keys: string[]): number {
  let compared: number;
  if (sort === 'recent') compared = -compareNullable(a.last_at, b.last_at);
  else if (sort === 'oldest') compared = compareNullable(a.first_at, b.first_at);
  else {
    const av = exactInteger(a.total_tokens), bv = exactInteger(b.total_tokens);
    compared = av === bv ? 0 : av === null ? 1 : bv === null ? -1 : av > bv ? -1 : 1;
  }
  if (compared) return compared;
  for (const key of keys) { compared = compareNullable(a[key] ?? null, b[key] ?? null); if (compared) return compared; }
  return 0;
}

/** At most 512 aggregate candidates are held even for a large OFFSET. Later blocks rescan the fixed view. */
export function* aggregatePage(store: QueryStore, where: SqlWhere, expressions: string[], limit: number, offset: number, sort: string, cacheBelow?: number): Generator<Statement, { rows: AggregateRow[]; total: number }, any> {
  const keys = expressions.map((_, i) => 'k' + i), compare = (a: AggregateRow, b: AggregateRow) => compareAggregate(a, b, sort, keys);
  let after: AggregateRow | null = null, skip = offset, total = 0, remaining = limit;
  const output: AggregateRow[] = [];
  for (;;) {
    const keep = Math.min(EXACT_EVENT_PAGE_SIZE, skip + remaining), heap: AggregateRow[] = []; total = 0;
    const insert = (row: AggregateRow) => {
      if (heap.length < keep) {
        heap.push(row); let i = heap.length - 1;
        while (i) { const parent = (i - 1) >>> 1; if (compare(heap[i], heap[parent]) <= 0) break; [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent; }
      } else if (keep && compare(row, heap[0]) < 0) {
        heap[0] = row; let i = 0;
        for (;;) { const left = i * 2 + 1; if (left >= heap.length) break; const right = left + 1, child = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left;
          if (compare(heap[child], heap[i]) <= 0) break; [heap[child], heap[i]] = [heap[i], heap[child]]; i = child; }
      }
    };
    yield* scanAggregates(store, where, expressions, row => {
      if (cacheBelow !== undefined && !cacheBelowExact(row, cacheBelow)) return;
      total++; if (!after || compare(row, after) > 0) insert(row);
    });
    const rows = heap.sort(compare);
    if (!rows.length || offset >= total) return { rows: output, total };
    if (skip < rows.length) { const selected = rows.slice(skip, skip + remaining); output.push(...selected); remaining -= selected.length; skip = 0; }
    else skip -= rows.length;
    if (!remaining || rows.length < keep) return { rows: output, total };
    after = rows.at(-1)!;
  }
}
