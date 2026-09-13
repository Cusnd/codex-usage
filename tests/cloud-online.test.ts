import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudDataSource } from '../modules/web/adapters/cloud.js';
import { jsonRequest, RequestError } from '../modules/web/adapters/http.js';
import { removeLegacyCloudCache } from '../modules/web/adapters/legacy-cache.js';
import { localDataSource } from '../modules/web/adapters/local.js';
import { namesFromProjects } from '../modules/web/adapters/project-labels.js';
import { dataQuery } from '../modules/web/data/data-query.js';
import type { PageRead } from '../modules/contracts/read-lease.js';
import type { ApiResponse } from '../modules/contracts/responses.js';

const identity = { origin: 'https://fixture.invalid', userId: 'online-user', deviceIds: [] as string[] };
const time = Date.parse('2026-09-13T12:00:00Z');
const read = (seq = 1): PageRead => ({ user_id: identity.userId, lease_id: 'view-' + seq,
  cut: { dataset_epoch: 'test-epoch', commit_seq: seq, deletion_version: 0, organization_version: 0, config_version: 0 },
  settings: { localInterval: 60, accountInterval: 300, timezoneMode: 'manual', timezone: 'UTC', costEnabled: false, officialApiPricing: false },
  expires_at: new Date(time + 15 * 60_000).toISOString() });
const response = <T>(data: T, page = read()): ApiResponse<T> => ({ data, meta: { source: 'cloud', timezone: 'UTC', updatedAt: null, warnings: [], cut: page.cut } } as ApiResponse<T>);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
type Call = { url: string; init: RequestInit };
function fixture(handler?: (call: Call, page: PageRead) => unknown | Promise<unknown>, ids = identity.deviceIds) {
  let page = read(); const calls: Call[] = [];
  const request: typeof jsonRequest = async <T>(url: string, init: RequestInit = {}) => {
    const call = { url, init }; calls.push(call);
    const custom = await handler?.(call, page); if (custom !== undefined) return custom as T;
    if (url === '/api/v3/view' || url.endsWith('/renew')) return structuredClone(page) as T;
    if (url.startsWith('/api/v3/accounts')) return { user_id: identity.userId, accounts: [{ remaining: 25 }] } as T;
    return response({ total: '9007199254741001' }, page) as T;
  };
  const source = new CloudDataSource({ ...identity, deviceIds: ids }, request, () => 'UTC', () => time);
  return { source, calls, set: (next: PageRead) => { page = next; } };
}
const isCode = (code: string) => (error: unknown) => error instanceof RequestError && error.code === code;

test('cold concurrent pages share one lightweight read and never request a mirror', async () => {
  const f = fixture();
  const [summary, trend, settings] = await Promise.all([f.source.query<{ total: string }>('local/summary'), f.source.query('local/trend'), f.source.query('settings')]);
  assert.equal(summary.data.total, '9007199254741001'); assert.ok(trend.data); assert.deepEqual(settings.data, read().settings);
  assert.equal(f.calls.filter(c => c.url === '/api/v3/view').length, 1);
  assert.equal(f.calls.filter(c => /sync\/|manifest|entities|changes/.test(c.url)).length, 0);
  assert.equal(f.calls.length, 3, 'settings are already part of the fixed read'); f.source.dispose();
});

test('device scope is normalized once; manual refresh only acquires a new page read', async () => {
  const f = fixture(undefined, ['b', 'a', 'b']); await f.source.refresh();
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { device_ids: ['a', 'b'] });
  const old = f.source.capture(); f.set(read(2)); await f.source.mutate('refresh', { source: 'local' });
  assert.equal(f.calls.length, 2); assert.equal(f.source.state().read?.cut.commit_seq, 2);
  await assert.rejects(f.source.query('local/summary', {}, undefined, old), isCode('VIEW_CHANGED')); f.source.dispose();
});

test('one canceled consumer does not cancel a shared request; the last consumer does', async () => {
  const reply = deferred<unknown>(); let aborted = 0;
  const f = fixture(({ url, init }) => { if (url.includes('/usage/')) { init.signal?.addEventListener('abort', () => aborted++); return reply.promise; } });
  await f.source.refresh(); const a = new AbortController(), b = new AbortController();
  const first = f.source.query('local/summary', {}, a.signal), second = f.source.query('local/summary', {}, b.signal);
  await tick(); a.abort(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(aborted, 0);
  reply.resolve(response({ total: '9007199254741001' })); assert.ok((await second).data);
  assert.equal(f.calls.filter(c => c.url.includes('/usage/')).length, 1); f.source.dispose();
  const wait = deferred<unknown>();
  const g = fixture(({ url, init }) => { if (url.includes('/usage/')) { init.signal?.addEventListener('abort', () => aborted++); return wait.promise; } });
  await g.source.refresh(); const only = new AbortController(), last = g.source.query('local/summary', {}, only.signal);
  await tick(); only.abort(); await assert.rejects(last, { name: 'AbortError' }); assert.equal(aborted, 1);
  wait.resolve(response({})); g.source.dispose();
});

test('refresh rejects late results from the previous cut', async () => {
  const late = deferred<unknown>(); const f = fixture(({ url }) => url.includes('/usage/') ? late.promise : undefined);
  await f.source.refresh(); const old = f.source.capture(), pending = f.source.query('local/summary', {}, undefined, old);
  await tick(); f.set(read(2)); await f.source.refresh(); late.resolve(response({ total: 'old' }));
  await assert.rejects(pending, isCode('VIEW_CHANGED')); assert.equal(f.source.state().read?.cut.commit_seq, 2); f.source.dispose();
});

test('deletion and disposal reject late work even when the transport ignores cancellation', async () => {
  for (const dispose of [false, true]) {
    const late = deferred<unknown>(), f = fixture(({ url }) => url.includes('/usage/') ? late.promise : undefined);
    await f.source.refresh(); const pending = f.source.query('local/summary'); await tick();
    if (dispose) f.source.dispose(); else f.source.invalidate();
    late.resolve(response({ total: 'old' })); await assert.rejects(pending, isCode('VIEW_CHANGED'));
    assert.equal(f.source.state().read, null); if (!dispose) f.source.dispose();
  }
});

test('a wrong authenticated read or wrong response cut is rejected', async () => {
  const bad = fixture(({ url }) => url === '/api/v3/view' ? { ...read(), user_id: 'other-user' } : undefined);
  await assert.rejects(bad.source.refresh(), isCode('VIEW_CHANGED')); assert.equal(bad.source.state().refreshing, false); assert.ok(bad.source.state().error); bad.source.dispose();
  const mismatch = fixture(({ url }) => url.includes('/usage/') ? response({}, read(9)) : undefined);
  await assert.rejects(mismatch.source.query('local/summary'), isCode('QUERY_CUT_MISMATCH')); mismatch.source.dispose();
});

test('account reads are independent of usage initialization and device filtering', async () => {
  const f = fixture(({ url }) => { if (url === '/api/v3/view') throw new RequestError('rebuilding', 'DATASET_UPDATING', 409); }, ['a']);
  const result = await f.source.query('account/cloud', { deviceIds: ['a'] }); assert.deepEqual(result.data, [{ remaining: 25 }]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/v3/accounts');
  await assert.rejects(f.source.refresh(), isCode('DATASET_UPDATING'));
  assert.deepEqual((await f.source.query('account/cloud')).data, [{ remaining: 25 }]); f.source.dispose();
});

test('account refresh invalidates late observations without invalidating the usage revision', async () => {
  const reply = deferred<unknown>(), f = fixture(({ url }) => url.startsWith('/api/v3/accounts') ? reply.promise : undefined);
  await f.source.refresh(); const revision = f.source.revision(), pending = f.source.query('account/cloud'); await tick();
  await f.source.mutate('refresh', { source: 'account' }); assert.equal(f.source.revision(), revision);
  reply.resolve({ user_id: identity.userId, accounts: [] }); await assert.rejects(pending, isCode('VIEW_CHANGED')); f.source.dispose();
});

test('concurrent near-expiry reads share renewal and preserve their fixed cut', async () => {
  const renewal = deferred<unknown>();
  const f = fixture(({ url }) => url.endsWith('/renew') ? renewal.promise : undefined);
  f.set({ ...read(), expires_at: new Date(time + 30_000).toISOString() }); await f.source.refresh();
  const view = f.source.capture(), a = f.source.query('local/summary', {}, undefined, view), b = f.source.query('local/trend', {}, undefined, view);
  await tick(); assert.equal(f.calls.filter(c => c.url.endsWith('/renew')).length, 1);
  renewal.resolve(read()); await Promise.all([a, b]); assert.equal(f.source.state().read?.cut.commit_seq, 1); f.source.dispose();
});

test('expired view recovery is bounded and publishes a new read for sibling queries', async () => {
  const f = fixture(({ url }) => { if (url.endsWith('/renew')) throw new RequestError('expired', 'BASELINE_REQUIRED', 409); });
  f.set({ ...read(), expires_at: new Date(time - 1).toISOString() }); await f.source.refresh(); const view = f.source.capture();
  f.set(read(2)); const results = await Promise.allSettled([f.source.query('local/summary', {}, undefined, view), f.source.query('local/trend', {}, undefined, view)]);
  assert.ok(results.every(r => r.status === 'rejected' && isCode('VIEW_CHANGED')(r.reason)));
  assert.equal(f.calls.filter(c => c.url === '/api/v3/view').length, 2); assert.equal(f.calls.filter(c => c.url.endsWith('/renew')).length, 1);
  assert.equal(f.source.state().read?.cut.commit_seq, 2); f.source.dispose();
});

test('browser timezone changes reject captured old queries; initial settings use server preferences', async () => {
  let zone = 'UTC'; const request: typeof jsonRequest = async <T>(url: string) => (url === '/api/v3/view' ? { ...read(), settings: { ...read().settings, timezoneMode: 'browser' } } : response({})) as T;
  const source = new CloudDataSource(identity, request, () => zone, () => time); await source.refresh();
  const captured = source.capture(); zone = 'Asia/Shanghai';
  await assert.rejects(source.query('local/summary', {}, undefined, captured), isCode('VIEW_CHANGED'));
  assert.equal((await source.query<{ timezone: string }>('settings')).data.timezone, zone); source.dispose();
  const manual = new CloudDataSource(identity, async <T>() => read() as T, () => 'Asia/Shanghai', () => time);
  assert.equal((await manual.query<{ timezone: string }>('settings', {}, undefined, manual.capture())).data.timezone, 'UTC'); manual.dispose();
});

test('project labels use the same read and keep aliases/source names without entity downloads', async () => {
  const f = fixture(({ url }, page) => url.includes('/usage/') ? response({ items: [{ project: 'source' }] }, page)
    : url.startsWith('/api/v3/projects') ? { lease_id: page.lease_id, cut: page.cut, projects: [{ id: 'p', name: '项目' }], aliases: { old: 'p' }, sources: [{ id: 'source', logical_project_id: 'p' }] } : undefined);
  await f.source.query('local/threads'); assert.equal(f.source.projectName('source'), '项目'); assert.equal(f.source.projectName('old'), '项目');
  await f.source.query('local/threads'); assert.equal(f.calls.filter(c => c.url.startsWith('/api/v3/projects')).length, 1);
  const names = namesFromProjects([{ id: 'p', name: ' ' }], { a: 'b', b: 'a', alias: 'p' }); assert.equal(names.alias, '未命名项目'); assert.equal(names.a, undefined); f.source.dispose();
});

test('settings mutations preserve optimistic config version and refresh only the page read', async () => {
  const f = fixture(({ url }) => url === '/api/v3/settings' ? { settings: { ...read().settings, costEnabled: true } } : undefined);
  await f.source.refresh(); const result = await f.source.mutate<{ costEnabled: boolean }>('settings', { costEnabled: true }, 'PATCH');
  assert.equal(result.data.costEnabled, true); const payload = JSON.parse(String(f.calls.find(c => c.url === '/api/v3/settings')?.init.body));
  assert.equal(payload.base_config_version, 0); assert.equal(typeof payload.operation_id, 'string'); assert.equal(f.calls.filter(c => c.url === '/api/v3/view').length, 2); f.source.dispose();
});

test('query keys and rolling boundaries advance with the online view', async () => {
  const f = fixture(); await f.source.refresh(); const before = dataQuery('local/summary', { to: 'old' }, 'UTC', true, f.source);
  await before.queryFn({ signal: new AbortController().signal });
  assert.equal(new URL(f.calls.at(-1)!.url, identity.origin).searchParams.get('to'), new Date(time).toISOString());
  f.set(read(2)); await f.source.refresh(); const after = dataQuery('local/summary', { to: 'new' }, 'UTC', true, f.source);
  assert.notDeepEqual(before.queryKey, after.queryKey); f.source.dispose();
});

test('legacy cache cleanup deletes only owned databases without opening a data store', async () => {
  const removed: string[] = [];
  const factory = { databases: async () => [{ name: 'codex-usage-cloud-old' }, { name: 'another-app' }, { name: 'codex-usage-local' }],
    deleteDatabase: (name: string) => { removed.push(name); return {}; }, open: () => { throw Error('must not open a cache'); } } as unknown as IDBFactory;
  await removeLegacyCloudCache(factory); assert.deepEqual(removed, ['codex-usage-cloud-old']);
});

test('the local adapter keeps ordinary HTTP behavior without cloud headers', async () => {
  const original = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(response({ ok: true })); };
  try {
    await localDataSource.query('local/summary', { project: 'a b' }); await localDataSource.mutate('refresh', { source: 'local' });
    assert.ok(calls[0].url.startsWith('/api/local/summary?')); assert.equal(new Headers(calls[0].init?.headers).has('X-Codex-Usage-Sync-Version'), false);
    assert.equal(calls[1].init?.method, 'POST'); assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { source: 'local' });
  } finally { globalThis.fetch = original; }
});
