import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudDataSource } from '../modules/web/adapters/cloud.js';
import { jsonRequest, RequestError } from '../modules/web/adapters/http.js';
import { removeLegacyCloudCache } from '../modules/web/adapters/legacy-cache.js';
import { localDataSource } from '../modules/web/adapters/local.js';
import { namesFromProjects } from '../modules/web/adapters/project-labels.js';
import { dataQuery } from '../modules/web/data/data-query.js';
import { prepareCloudRefresh, refreshRollingQueries } from '../modules/web/data/cloud-refresh.js';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { PageRead } from '../modules/contracts/read-lease.js';
import type { ApiResponse } from '../modules/contracts/responses.js';

const identity = { origin: 'https://fixture.invalid', userId: 'online-user', deviceIds: [] as string[] };
const time = Date.parse('2026-09-13T12:00:00Z');
const read = (seq = 1): PageRead => ({ user_id: identity.userId, lease_id: 'view-' + seq,
  cut: { dataset_epoch: 'test-epoch', commit_seq: seq, deletion_version: 0, organization_version: 0, config_version: 0 },
  settings: { localInterval: 60, accountInterval: 300, timezoneMode: 'manual', timezone: 'UTC', costEnabled: false, officialApiPricing: false },
  expires_at: new Date(time + 15 * 60_000).toISOString() });
type CloudResponse<T> = ApiResponse<T> & { meta: { cut: PageRead['cut'] } };
const response = <T>(data: T, page = read()): CloudResponse<T> => ({ data, meta: { source: 'cloud', timezone: 'UTC', updatedAt: null, warnings: [], cut: page.cut } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
type Call = { url: string; init: RequestInit };
function fixture(handler?: (call: Call, page: PageRead) => unknown | Promise<unknown>, ids = identity.deviceIds, now = () => time) {
  let page = read(); const calls: Call[] = [];
  const request: typeof jsonRequest = async <T>(url: string, init: RequestInit = {}) => {
    const call = { url, init }; calls.push(call);
    const custom = await handler?.(call, page); if (custom !== undefined) return custom as T;
    if (url === '/api/v3/view' || url.endsWith('/renew')) return structuredClone(page) as T;
    if (url.startsWith('/api/v3/accounts')) return { user_id: identity.userId, accounts: [{ remaining: 25 }] } as T;
    return response({ total: '9007199254741001' }, page) as T;
  };
  const source = new CloudDataSource({ ...identity, deviceIds: ids }, request, () => 'UTC', now);
  return { source, calls, set: (next: PageRead) => { page = next; } };
}
const isCode = (code: string) => (error: unknown) => error instanceof RequestError && error.code === code;
const usageCalls = (calls: Call[]) => calls.filter(call => call.url.startsWith('/api/v3/usage/query?'));
const payload = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const usageRoute = (call: Call) => new URL(call.url, identity.origin).searchParams.get('route');
const queryClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, gcTime: Infinity } } });

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

test('inline page labels merge at the current cut without requesting project directories', async () => {
  const f = fixture((call, page) => {
    if (!call.url.includes('/usage/')) return;
    const id = payload(call).offset ? 'chat' : 'source', result = response({ items: [{ project: id }] }, page);
    result.meta.projectLabels = [{ id, name: id === 'chat' ? 'Session title' : '项目', kind: id === 'chat' ? 'session' : 'project' },
      { id: 'old', name: '项目', kind: 'project' }];
    return result;
  });
  await f.source.query('local/threads', { project: 'old', limit: 20 });
  await f.source.query('local/threads', { project: 'old', limit: 20, offset: 20 });
  assert.equal(f.source.projectName('source'), '项目'); assert.equal(f.source.projectName('old'), '项目');
  assert.equal(f.source.projectName('chat'), 'Session title'); assert.equal(f.source.projectKind('chat'), 'session');
  assert.equal(f.calls.length, 3); assert.equal(f.calls.filter(c => c.url.startsWith('/api/v3/projects')).length, 0);
  for (const call of usageCalls(f.calls)) {
    assert.equal(call.init.method, 'POST'); assert.equal(new Headers(call.init.headers).get('Content-Type'), 'application/json');
    assert.deepEqual([...new URL(call.url, identity.origin).searchParams.keys()], ['route']);
    assert.equal(payload(call).lease_id, 'view-1'); assert.equal(payload(call).project, 'old');
  }
  f.set(read(2)); await f.source.refresh(); assert.equal(f.source.projectName('source'), undefined);
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
  assert.equal(payload(f.calls.at(-1)!).to, new Date(time).toISOString());
  f.set(read(2)); await f.source.refresh(); const after = dataQuery('local/summary', { to: 'new' }, 'UTC', true, f.source);
  assert.notDeepEqual(before.queryKey, after.queryKey); f.source.dispose();
});

test('equivalent POST parameters share in-flight work after undefined fields are removed', async () => {
  const reply = deferred<unknown>(), f = fixture(call => call.url.includes('/usage/') ? reply.promise : undefined);
  try {
    await f.source.refresh();
    const first = f.source.query('local/threads', { limit: 20, project: 'session/id', model: undefined });
    const second = f.source.query('local/threads', { project: 'session/id', limit: 20 });
    await tick(); const calls = usageCalls(f.calls); assert.equal(calls.length, 1);
    assert.deepEqual(payload(calls[0]), { lease_id: 'view-1', limit: 20, project: 'session/id', timezone: 'UTC' });
    assert.equal(new URL(calls[0].url, identity.origin).search, '?route=local%2Fthreads');
    reply.resolve(response({ items: [] })); await Promise.all([first, second]);
  } finally { f.source.dispose(); }
});

test('a new cut stages all active results before publication and observers reuse the prepared cache', async () => {
  const overview = deferred<unknown>(), groups = deferred<unknown>();
  const f = fixture((call, page) => {
    if (!call.url.includes('/usage/')) return;
    if (page.cut.commit_seq === 2) return usageRoute(call) === 'local/overview' ? overview.promise : groups.promise;
    const result = response({ value: usageRoute(call) + ':old' }, page);
    result.meta.projectLabels = [{ id: 'old', name: 'Old title', kind: 'session' }]; return result;
  });
  const client = queryClient();
  await f.source.refresh();
  const options = (route: string) => dataQuery<{ value: string }>(route, { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'UTC', false, f.source);
  const routes = ['local/overview', 'local/breakdown'], observers = routes.map(route => new QueryObserver(client, options(route)));
  const unsubscribers = observers.map(observer => observer.subscribe(() => {}));
  try {
    await Promise.all(routes.map(route => client.fetchQuery(options(route))));
    // An unobserved result must not turn every page ever visited into refresh work.
    client.setQueryData(dataQuery('local/threads', {}, 'UTC', false, f.source).queryKey, response({ value: 'inactive' }));
    f.source.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, f.source);
    let published = 0;
    const unsubscribe = f.source.subscribe(() => {
      if (f.source.state().read?.cut.commit_seq !== 2) return;
      published++;
      for (const route of routes) assert.equal(client.getQueryData<ApiResponse<{ value: string }>>(options(route).queryKey)?.data.value, route + ':new');
      assert.equal(f.source.projectName('new'), 'New title');
    });
    try {
      f.set(read(2)); const refreshing = f.source.refresh(); await tick();
      assert.equal(f.source.state().read?.cut.commit_seq, 1);
      const first = response({ value: 'local/overview:new' }, read(2));
      first.meta.projectLabels = [{ id: 'new', name: 'New title', kind: 'session' }]; overview.resolve(first); await tick();
      assert.equal(published, 0); assert.ok(client.getQueryCache().findAll().every(query => (query.state.data as CloudResponse<unknown>)?.meta?.cut?.commit_seq !== 2));
      groups.resolve(response({ value: 'local/breakdown:new' }, read(2))); await refreshing;
      assert.equal(published, 1); assert.equal(f.source.projectName('old'), undefined);
      observers.forEach((observer, index) => observer.setOptions(options(routes[index]))); await tick();
      assert.deepEqual(observers.map(observer => observer.getCurrentResult().data?.data.value), routes.map(route => route + ':new'));
      const prepared = usageCalls(f.calls).filter(call => payload(call).lease_id === 'view-2');
      assert.deepEqual(prepared.map(usageRoute).sort(), [...routes].sort(), 'changing observer keys must not repeat the two staged API reads');
    } finally { unsubscribe(); }
  } finally { unsubscribers.forEach(stop => stop()); observers.forEach(observer => observer.destroy()); client.clear(); f.source.dispose(); }
});

test('a failed prepared page retains the complete old cut and does not cache partial new results', async () => {
  const failed = deferred<unknown>();
  const f = fixture((call, page) => {
    if (!call.url.includes('/usage/')) return;
    if (page.cut.commit_seq === 2 && usageRoute(call) === 'local/trend') return failed.promise;
    const result = response({ value: page.cut.commit_seq }, page);
    result.meta.projectLabels = [{ id: 'session', name: page.cut.commit_seq === 1 ? 'Old title' : 'New title', kind: 'session' }]; return result;
  });
  const client = queryClient(); await f.source.refresh();
  const routes = ['local/summary', 'local/trend'];
  const options = routes.map(route => dataQuery<{ value: number }>(route, {}, 'UTC', false, f.source));
  const observers = options.map(option => new QueryObserver(client, option)), stops = observers.map(observer => observer.subscribe(() => {}));
  try {
    await Promise.all(options.map(option => client.fetchQuery(option)));
    f.source.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, f.source);
    f.set(read(2)); const refresh = f.source.refresh(), rejected = assert.rejects(refresh, /temporary trend failure/);
    await tick(); assert.equal(f.source.projectName('session'), 'Old title');
    failed.reject(new Error('temporary trend failure')); await rejected;
    assert.equal(f.source.state().read?.cut.commit_seq, 1); assert.equal(f.source.state().refreshing, false);
    assert.match(f.source.state().error ?? '', /temporary trend failure/); assert.equal(f.source.projectName('session'), 'Old title');
    assert.deepEqual(observers.map(observer => observer.getCurrentResult().data?.data.value), [1, 1]);
    assert.equal(client.getQueryCache().findAll().length, 2);
    assert.ok(client.getQueryCache().findAll().every(query => (query.state.data as CloudResponse<unknown>).meta.cut?.commit_seq === 1));
  } finally { stops.forEach(stop => stop()); observers.forEach(observer => observer.destroy()); client.clear(); f.source.dispose(); }
});

test('same-cut refresh advances only rolling queries while fixed historical results remain cached', async () => {
  let now = time, prepareCount = 0;
  const f = fixture((call, page) => call.url.includes('/usage/') ? response({ to: payload(call).to }, page) : undefined, [], () => now);
  const client = queryClient(); await f.source.refresh();
  const fixedParams = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
  const rollingParams = { from: '2026-09-13T00:00:00Z', to: new Date(now).toISOString() };
  const fixed = () => dataQuery<{ to: string }>('local/summary', fixedParams, 'UTC', false, f.source);
  const rolling = () => dataQuery<{ to: string }>('local/summary', { ...rollingParams, to: new Date(now).toISOString() }, 'UTC', true, f.source);
  const fixedObserver = new QueryObserver(client, fixed()), rollingObserver = new QueryObserver(client, rolling());
  const stops = [fixedObserver.subscribe(() => {}), rollingObserver.subscribe(() => {})];
  try {
    await Promise.all([client.fetchQuery(fixed()), client.fetchQuery(rolling())]);
    const fixedData = client.getQueryData(fixed().queryKey), oldKey = rolling().queryKey;
    f.source.prepareRefresh = async (candidate, signal) => { prepareCount++; return prepareCloudRefresh(client, candidate, signal, f.source); };
    now += 60_000; f.set({ ...read(), lease_id: 'view-1-renewed' }); await f.source.refresh();
    assert.equal(prepareCount, 0); assert.deepEqual(rolling().queryKey, oldKey);
    // CloudSession calls this only when the published cut is unchanged and viewAt advances.
    await refreshRollingQueries(client);
    assert.strictEqual(client.getQueryData(fixed().queryKey), fixedData);
    assert.equal(client.getQueryState(fixed().queryKey)?.isInvalidated, false);
    assert.equal(fixedObserver.getCurrentResult().data?.data.to, fixedParams.to);
    assert.equal(rollingObserver.getCurrentResult().data?.data.to, new Date(now).toISOString());
    assert.equal(usageCalls(f.calls).length, 3); assert.equal(payload(usageCalls(f.calls).at(-1)!).lease_id, 'view-1-renewed');
    await client.fetchQuery(fixed()); assert.equal(usageCalls(f.calls).length, 3);
  } finally { stops.forEach(stop => stop()); fixedObserver.destroy(); rollingObserver.destroy(); client.clear(); f.source.dispose(); }
});

test('canceling preparation cannot publish new cache data or late project labels', async () => {
  const late = deferred<unknown>(); let aborted = 0;
  const f = fixture((call, page) => {
    if (!call.url.includes('/usage/')) return;
    if (page.cut.commit_seq === 2) { call.init.signal?.addEventListener('abort', () => aborted++); return late.promise; }
    const result = response({ value: 'old' }, page); result.meta.projectLabels = [{ id: 'old', name: 'Old title', kind: 'session' }]; return result;
  });
  const client = queryClient(); await f.source.refresh();
  const options = dataQuery('local/threads', {}, 'UTC', false, f.source), observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options); f.source.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, f.source);
    f.set(read(2)); const refresh = f.source.refresh(), rejected = assert.rejects(refresh, error => isCode('VIEW_CHANGED')(error) || (error as Error).name === 'AbortError');
    await tick(); f.source.invalidate(); await client.cancelQueries(); client.clear(); await rejected;
    const result = response({ value: 'late' }, read(2)); result.meta.projectLabels = [{ id: 'late', name: 'Late title', kind: 'session' }];
    late.resolve(result); await tick();
    assert.equal(aborted, 1); assert.equal(f.source.state().read, null); assert.equal(client.getQueryCache().findAll().length, 0);
    assert.equal(f.source.projectName('old'), undefined); assert.equal(f.source.projectName('late'), undefined);
  } finally { stop(); observer.destroy(); client.clear(); f.source.dispose(); }
});

test('a deletion learned during refresh removes private cached pages before exposing the new cut', async () => {
  const f = fixture((call, page) => {
    if (!call.url.includes('/usage/')) return;
    const result = response({ value: 'deleted detail' }, page); result.meta.projectLabels = [{ id: 'deleted', name: 'Deleted title', kind: 'session' }]; return result;
  });
  const client = queryClient(); await f.source.refresh();
  const options = dataQuery('local/threads/deleted', {}, 'UTC', false, f.source), observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options); client.setQueryData(['account', 'account/cloud'], response({ value: 'old account' }));
    f.source.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, f.source);
    let discarded = 0;
    f.source.discardHistory = () => { discarded++; void client.cancelQueries(); client.clear(); };
    const next = read(2); next.cut.deletion_version = 1; f.set(next); await f.source.refresh();
    assert.equal(discarded, 1); assert.equal(client.getQueryCache().findAll().length, 0);
    assert.equal(f.source.projectName('deleted'), undefined); assert.equal(f.source.state().read?.cut.deletion_version, 1);
    assert.equal(usageCalls(f.calls).length, 1, 'revoked details are cleared, not staged into the replacement view');
  } finally { stop(); observer.destroy(); client.clear(); f.source.dispose(); }
});

test('legacy cache cleanup deletes only owned databases without opening a data store', async () => {
  const removed: string[] = [];
  const factory = { databases: async () => [{ name: 'codex-usage-cloud-old' }, { name: 'another-app' }, { name: 'codex-usage-local' }],
    deleteDatabase: (name: string) => { removed.push(name); return {}; }, open: () => { throw Error('must not open a cache'); } } as unknown as IDBFactory;
  await removeLegacyCloudCache(factory); assert.deepEqual(removed, ['codex-usage-cloud-old']);
});

test('the local adapter keeps ordinary HTTP behavior without cloud headers', async () => {
  const original = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); const result = response({ ok: true });
    result.meta.projectLabels = [{id:'a b',name:'Local project',kind:'project'}]; return Response.json(result); };
  try {
    await localDataSource.query('local/summary', { project: 'a b' }); await localDataSource.mutate('refresh', { source: 'local' });
    assert.equal(calls[0].url, '/api/local/query?route=summary'); assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project: 'a b' });
    assert.equal(new Headers(calls[0].init?.headers).has('X-Codex-Usage-Sync-Version'), false);
    assert.equal(localDataSource.projectName?.('a b'),'Local project');
    assert.equal(localDataSource.projectKind?.('a b'),'project'); assert.equal(calls.length, 2);
    assert.equal(calls[1].init?.method, 'POST'); assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { source: 'local' });
  } finally { globalThis.fetch = original; }
});
