import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { CloudDataSource } from '../modules/web/adapters/cloud.js';
import { jsonRequest, RequestError } from '../modules/web/adapters/http.js';
import { prepareCloudRefresh } from '../modules/web/data/cloud-refresh.js';
import { dataQuery } from '../modules/web/data/data-query.js';
import type { PageRead } from '../modules/contracts/read-lease.js';
import type { ApiResponse } from '../modules/contracts/responses.js';

const initialTime = Date.parse('2026-09-13T12:00:00Z');
const identity = { origin: 'https://fixture.invalid', userId: 'online-view-user', deviceIds: ['device-a'] };
const page = (sequence = 1): PageRead => ({
  user_id: identity.userId, lease_id: 'read-' + sequence,
  cut: { dataset_epoch: 'fixture', commit_seq: sequence, deletion_version: 0, organization_version: 0, config_version: 0 },
  settings: { localInterval: 60, accountInterval: 300, timezone: 'UTC', timezoneMode: 'manual', costEnabled: false, officialApiPricing: false },
  expires_at: new Date(initialTime + 900_000).toISOString(),
});
type CloudResponse = ApiResponse<unknown> & { meta: ApiResponse<unknown>['meta'] & { cut: PageRead['cut'] } };
const responseCut = (response: ApiResponse<unknown> | undefined) => (response as CloudResponse | undefined)?.meta.cut;
const dto = (read: PageRead, route: string): CloudResponse => ({
  data: { value: `${route} at ${read.cut.commit_seq}` },
  meta: { source: 'cloud', timezone: read.settings.timezone, updatedAt: null, warnings: [], cut: read.cut },
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
type Call = { url: string; init: RequestInit; read: PageRead };

function fixture(t: TestContext, handler?: (call: Call) => unknown | Promise<unknown>) {
  let head = page(), now = initialTime;
  const reads = new Map([[head.lease_id, head]]), calls: Call[] = [];
  const request: typeof jsonRequest = async <T>(url: string, init: RequestInit = {}) => {
    const parsed = new URL(url, identity.origin);
    const read = structuredClone(url === '/api/v3/view' ? head : reads.get(parsed.searchParams.get('lease_id') || '') ?? head);
    const call = { url, init, read }; calls.push(call);
    const overridden = await handler?.(call);
    if (overridden !== undefined) return overridden as T;
    if (url === '/api/v3/view') return read as T;
    return dto(read, parsed.pathname.replace('/api/v3/usage/', '')) as T;
  };
  const source = new CloudDataSource(identity, request, () => 'UTC', () => now);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  source.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, source);
  const disposers: (() => void)[] = [];
  t.after(() => { for (const dispose of disposers) dispose(); source.dispose(); client.clear(); });
  const options = (route: string, params: Record<string, unknown> = {}) => ({
    ...(route === 'settings' || route === 'status'
      ? { queryKey: [route], queryFn: ({ signal }: { signal: AbortSignal }) => source.query<unknown>(route, {}, signal) }
      : dataQuery<unknown>(route, params, source.capture().timezone!, true, source)),
    retry: false, staleTime: Infinity, gcTime: Infinity,
  });
  const observe = (route: string, params: Record<string, unknown> = {}) => {
    const observer = new QueryObserver(client, options(route, params));
    const stop = observer.subscribe(() => {}); disposers.push(stop);
    return { observer, options: () => options(route, params), stop };
  };
  return { source, client, calls, observe, options,
    setHead: (next: PageRead) => { head = next; reads.set(next.lease_id, next); },
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

test('a same-cut refresh keeps displayed query data when its new GET fails', async t => {
  let failed = false;
  const f = fixture(t, ({ url }) => { if (failed && url.includes('/usage/')) throw new TypeError('connection lost'); });
  await f.source.refresh();
  const summary = f.observe('local/summary', { from: '2026-09-13T00:00:00Z', to: '2026-09-13T12:00:00Z' });
  await summary.observer.refetch({ throwOnError: true });
  const before = structuredClone(summary.observer.getCurrentResult().data), key = summary.options().queryKey;
  f.advance(60_000); failed = true; await f.source.refresh();
  assert.deepEqual(summary.options().queryKey, key);
  assert.equal(f.source.clock(), initialTime + 60_000);
  summary.observer.setOptions(summary.options());
  const pending = summary.observer.refetch();
  assert.deepEqual(summary.observer.getCurrentResult().data, before);
  await pending;
  assert.equal(summary.observer.getCurrentResult().isError, true);
  assert.match(summary.observer.getCurrentResult().error?.message || '', /connection lost/);
  assert.deepEqual(summary.observer.getCurrentResult().data, before);
});

test('one failed candidate query preserves the entire previously displayed cut and settings', async t => {
  const f = fixture(t, ({ url, read }) => {
    if (read.cut.commit_seq === 2 && url.includes('/usage/local/trend')) throw new Error('trend unavailable');
  });
  await f.source.refresh();
  const visible = ['local/summary', 'local/trend', 'settings', 'status'].map(route => f.observe(route));
  await Promise.all(visible.map(item => item.observer.refetch({ throwOnError: true })));
  const before = visible.map(item => structuredClone(item.observer.getCurrentResult().data));
  const next = page(2); next.settings.costEnabled = true; next.cut.config_version = 1;
  f.setHead(next); f.advance(1000);
  await assert.rejects(f.source.refresh(), /trend unavailable/);
  assert.deepEqual(f.source.state().read, page());
  assert.equal(f.source.clock(), initialTime);
  assert.equal(f.source.state().refreshing, false);
  assert.match(f.source.state().error || '', /trend unavailable/);
  visible.forEach((item, index) => assert.deepEqual(item.observer.getCurrentResult().data, before[index]));
  assert.equal(f.client.getQueryCache().getAll().length, visible.length, 'successful siblings must remain uncommitted');
  assert.ok(f.calls.some(call => call.read.cut.commit_seq === 2 && call.url.includes('/usage/local/summary')));
});

test('all candidate results are ready before the new read is published or observed', async t => {
  const trend = deferred<unknown>();
  const f = fixture(t, ({ url, read }) => read.cut.commit_seq === 2 && url.includes('/usage/local/trend') ? trend.promise : undefined);
  await f.source.refresh();
  const routes = ['local/summary', 'local/trend', 'settings', 'status'];
  const visible = routes.map(route => f.observe(route, route.startsWith('local/') ? { from: '2026-09-13T00:00:00.000Z', to: '2026-09-13T12:00:00.000Z' } : {}));
  await Promise.all(visible.map(item => item.observer.refetch({ throwOnError: true })));
  const next = page(2); next.settings.costEnabled = true; next.cut.config_version = 1;
  f.setHead(next); f.advance(1000);
  const pending = f.source.refresh(); await tick();
  assert.equal(f.source.state().read?.cut.commit_seq, 1);
  visible.forEach(item => assert.equal(responseCut(item.observer.getCurrentResult().data)?.commit_seq, 1));
  let published = false;
  const stop = f.source.subscribe(() => {
    if (f.source.state().read?.cut.commit_seq !== 2) return;
    published = true;
    for (const item of visible) assert.equal(responseCut(f.client.getQueryData<ApiResponse<unknown>>(item.options().queryKey))?.commit_seq, 2);
  });
  t.after(stop);
  trend.resolve(dto(next, 'local/trend')); await pending;
  assert.equal(published, true);
  assert.equal(f.source.state().error, null);
  const callCount = f.calls.length;
  visible.forEach(item => item.observer.setOptions(item.options()));
  await tick();
  visible.forEach(item => assert.equal(responseCut(item.observer.getCurrentResult().data)?.commit_seq, 2));
  assert.equal(f.calls.length, callCount, 'publishing does not leave displayed queries missing from the new keys');
  assert.equal(f.client.getQueryData<ApiResponse<{ costEnabled: boolean }>>(['settings'])?.data.costEnabled, true);
});

test('candidate preparation excludes inactive history and account data', async t => {
  const f = fixture(t); await f.source.refresh();
  const shown = f.observe('local/summary'); await shown.observer.refetch({ throwOnError: true });
  const inactiveKey = f.options('local/threads/old').queryKey;
  f.client.setQueryData(inactiveKey, dto(page(), 'local/threads/old'));
  const account = new QueryObserver(f.client, { queryKey: ['account', 'account/cloud'], queryFn: async () => ({ data: 'account snapshot' }), staleTime: Infinity });
  const stop = account.subscribe(() => {}); t.after(stop); await account.refetch();
  const start = f.calls.length; f.setHead(page(2)); await f.source.refresh();
  const prepared = f.calls.slice(start).filter(call => call.url !== '/api/v3/view');
  assert.equal(prepared.length, 1); assert.ok(prepared[0].url.includes('/usage/local/summary'));
  assert.deepEqual(f.client.getQueryData(inactiveKey), dto(page(), 'local/threads/old'));
  assert.deepEqual(account.getCurrentResult().data, { data: 'account snapshot' });
});

test('a timezone change prepares the rolling bounds and exact key that the next page uses', async t => {
  const f = fixture(t); await f.source.refresh();
  const summary = f.observe('local/summary', { from: '2026-09-13T00:00:00.000Z', to: '2026-09-13T12:00:00.000Z', deviceIds: ['device-a'] });
  await summary.observer.refetch({ throwOnError: true });
  const next = page(2); next.settings.timezone = 'Asia/Tokyo'; next.cut.config_version = 1;
  f.setHead(next); await f.source.refresh();
  // At 21:00 in Tokyo, "today" begins at the previous UTC day's 15:00.
  const nextParams = { from: '2026-09-12T15:00:00.000Z', to: '2026-09-13T12:00:00.000Z', deviceIds: ['device-a'] };
  const expected = dataQuery<unknown>('local/summary', nextParams, 'Asia/Tokyo', true, f.source);
  assert.deepEqual(f.client.getQueryData(expected.queryKey), dto(next, 'local/summary'));
  const prepared = f.calls.find(call => call.url.includes('/usage/local/summary') && call.read.cut.commit_seq === 2);
  assert.ok(prepared);
  const params = new URL(prepared.url, identity.origin).searchParams;
  assert.equal(params.get('from'), nextParams.from); assert.equal(params.get('timezone'), 'Asia/Tokyo');
  assert.equal(params.get('to'), nextParams.to);
});

test('a new cut across local midnight prepares the next day rather than yesterday', async t => {
  const f = fixture(t), first = page(); first.settings.timezone = 'Pacific/Fiji';
  f.setHead(first); f.advance(-60_000); await f.source.refresh();
  const summary = f.observe('local/summary', { from: '2026-09-12T12:00:00.000Z', to: '2026-09-13T11:59:00.000Z' });
  await summary.observer.refetch({ throwOnError: true });
  const next = page(2); next.settings.timezone = first.settings.timezone;
  f.setHead(next); f.advance(120_000); await f.source.refresh();
  // Fiji has crossed from 23:59 on September 13 to 00:01 on September 14.
  const nextParams = { from: '2026-09-13T12:00:00.000Z', to: '2026-09-13T12:01:00.000Z' };
  const expected = dataQuery<unknown>('local/summary', nextParams, 'Pacific/Fiji', true, f.source);
  assert.deepEqual(f.client.getQueryData(expected.queryKey), dto(next, 'local/summary'));
  const prepared = f.calls.find(call => call.url.includes('/usage/local/summary') && call.read.cut.commit_seq === 2);
  assert.ok(prepared);
  const params = new URL(prepared.url, identity.origin).searchParams;
  assert.equal(params.get('from'), nextParams.from); assert.equal(params.get('to'), nextParams.to);
});

test('history invalidation cancels candidate promotion and cannot refill cleared query data', async t => {
  const late = deferred<unknown>();
  const f = fixture(t, ({ url, read }) => read.cut.commit_seq === 2 && url.includes('/usage/') ? late.promise : undefined);
  await f.source.refresh();
  const summary = f.observe('local/summary'); await summary.observer.refetch({ throwOnError: true });
  const old = f.source.capture();
  f.setHead(page(2)); const pending = f.source.refresh();
  const rejected = assert.rejects(pending, error => error instanceof RequestError && error.code === 'VIEW_CHANGED' || error instanceof DOMException && error.name === 'AbortError');
  await tick();
  f.source.invalidate();
  assert.notEqual(f.source.capture().generation, old.generation, 'the mounted page generation must change even without another successful read');
  await f.client.cancelQueries(); f.client.removeQueries();
  late.resolve(dto(page(2), 'local/summary')); await rejected; await tick();
  assert.equal(f.source.state().read, null);
  assert.equal(f.client.getQueryCache().getAll().length, 0);
  await assert.rejects(f.source.query('local/summary', {}, undefined, old), error => error instanceof RequestError && error.code === 'VIEW_CHANGED');
});

test('a deletion learned from another browser discards old detail before a replacement 404', async t => {
  const f = fixture(t, ({ url, read }) => {
    if (url.includes('/usage/local/threads/deleted') && read.cut.deletion_version === 1) throw new RequestError('deleted detail', 'NOT_FOUND', 404);
  });
  let discarded = 0;
  f.source.discardHistory = () => {
    discarded++;
    assert.equal(f.source.state().read, null, 'the old view is revoked before its caches are discarded');
    void f.client.cancelQueries(); f.client.removeQueries();
  };
  await f.source.refresh();
  const detail = f.observe('local/threads/deleted'); await detail.observer.refetch({ throwOnError: true });
  const oldKey = detail.options().queryKey, oldView = f.source.capture();
  assert.ok(f.client.getQueryData(oldKey));
  const next = page(2); next.cut.deletion_version = 1; f.setHead(next);
  await f.source.refresh();
  assert.equal(discarded, 1);
  assert.notEqual(f.source.capture().generation, oldView.generation);
  assert.equal(f.source.state().read?.cut.deletion_version, 1);
  assert.equal(f.client.getQueryData(oldKey), undefined);
  assert.equal(f.client.getQueryCache().getAll().length, 0);
  detail.stop();
  const reopened = f.observe('local/threads/deleted'); await reopened.observer.refetch();
  assert.equal(reopened.observer.getCurrentResult().data, undefined);
  assert.equal((reopened.observer.getCurrentResult().error as RequestError).status, 404);
  await assert.rejects(f.source.query('local/threads/deleted', {}, undefined, oldView), error => error instanceof RequestError && error.code === 'VIEW_CHANGED');
});

test('observations fetched during deletion are refreshed when the invalidated page becomes readable', async t => {
  const f = fixture(t);
  await f.source.refresh(); f.source.invalidate();
  const pendingDeletionRevision = f.source.revision('account/cloud');
  const next = page(2); next.cut.deletion_version = 1; f.setHead(next);
  await f.source.refresh();
  assert.notEqual(f.source.revision('account/cloud'), pendingDeletionRevision);
  const readyRevision = f.source.revision('account/cloud');
  await f.source.refresh();
  assert.equal(f.source.revision('account/cloud'), readyRevision, 'ordinary usage refreshes keep account observations independent');
});

test('an ordinary epoch rebuild may retain a valid previous cut when preparation fails', async t => {
  const f = fixture(t, ({ url, read }) => {
    if (read.cut.dataset_epoch === 'rebuilt' && url.includes('/usage/')) throw new Error('replacement unavailable');
  });
  let discarded = 0; f.source.discardHistory = () => { discarded++; };
  await f.source.refresh();
  const detail = f.observe('local/threads/retained'); await detail.observer.refetch({ throwOnError: true });
  const before = structuredClone(detail.observer.getCurrentResult().data), oldView = f.source.capture();
  const next = page(2); next.cut.dataset_epoch = 'rebuilt'; f.setHead(next);
  await assert.rejects(f.source.refresh(), /replacement unavailable/);
  assert.equal(discarded, 0);
  assert.equal(f.source.capture().generation, oldView.generation);
  assert.deepEqual(f.source.state().read, page());
  assert.deepEqual(detail.observer.getCurrentResult().data, before);
  assert.deepEqual(await f.source.query('local/threads/retained', {}, undefined, oldView), before);
});

test('a server-revoked read is discarded even when acquiring its replacement fails', async t => {
  let revoked = false;
  const f = fixture(t, ({ url }) => {
    if (!revoked) return;
    if (url === '/api/v3/view') throw new TypeError('replacement connection lost');
    if (url.includes('/usage/')) throw new RequestError('read revoked by deletion', 'BASELINE_REQUIRED', 409);
  });
  let discarded = 0;
  f.source.discardHistory = () => {
    discarded++;
    assert.equal(f.source.state().read, null);
    void f.client.cancelQueries(); f.client.removeQueries();
  };
  await f.source.refresh();
  const detail = f.observe('local/threads/deleted'); await detail.observer.refetch({ throwOnError: true });
  const oldKey = detail.options().queryKey, oldView = f.source.capture();
  assert.ok(f.client.getQueryData(oldKey));
  assert.ok(Date.parse(oldView.lease!.expires_at) > f.source.clock(), 'the server, not the browser clock, revoked this read');
  revoked = true; await detail.observer.refetch(); await tick();
  assert.equal(f.source.state().read, null, 'failed recovery cannot retain a read already rejected by the server');
  assert.equal(discarded, 1);
  assert.notEqual(f.source.capture().generation, oldView.generation);
  assert.equal(f.client.getQueryData(oldKey), undefined);
  assert.equal(f.client.getQueryCache().getAll().length, 0);
  assert.equal(f.calls.filter(call => call.url === '/api/v3/view').length, 2, 'one replacement read attempt is sufficient');
  detail.stop();
  const reopened = f.observe('local/threads/deleted'); await reopened.observer.refetch();
  assert.equal(reopened.observer.getCurrentResult().data, undefined);
  assert.match(reopened.observer.getCurrentResult().error?.message || '', /replacement connection lost/);
});

test('a temporary 503 on a still-valid read preserves displayed data without discarding history', async t => {
  let unavailable = false;
  const f = fixture(t, ({ url }) => {
    if (unavailable && url.includes('/usage/')) throw new RequestError('temporarily unavailable', 'HTTP_ERROR', 503);
  });
  let discarded = 0; f.source.discardHistory = () => { discarded++; };
  await f.source.refresh();
  const detail = f.observe('local/threads/retained'); await detail.observer.refetch({ throwOnError: true });
  const before = structuredClone(detail.observer.getCurrentResult().data), oldView = f.source.capture();
  unavailable = true; await detail.observer.refetch();
  assert.equal((detail.observer.getCurrentResult().error as RequestError).status, 503);
  assert.equal(discarded, 0);
  assert.equal(f.source.capture().generation, oldView.generation);
  assert.deepEqual(f.source.state().read, page());
  assert.deepEqual(detail.observer.getCurrentResult().data, before);
  assert.deepEqual(f.client.getQueryData(detail.options().queryKey), before);
  assert.equal(f.calls.filter(call => call.url === '/api/v3/view').length, 1);
});

test('the clock snapshot stays stable until a read is published, including after invalidation', async t => {
  const f = fixture(t); const initial = f.source.clock();
  f.advance(1000); assert.equal(f.source.clock(), initial);
  await f.source.refresh(); const published = f.source.clock();
  f.advance(1000); assert.equal(f.source.clock(), published);
  f.source.invalidate(); const invalidated = f.source.clock();
  f.advance(1000); assert.equal(f.source.clock(), invalidated);
});

test('settings saved during an earlier refresh acquire a read that starts after the write', async t => {
  const earlierRead = deferred<unknown>(); let hold = false, saved = false;
  const f = fixture(t, ({ url, read }) => {
    if (url === '/api/v3/view' && hold && !saved) return earlierRead.promise;
    if (url === '/api/v3/settings') {
      saved = true;
      const next = { ...page(2), cut: { ...page(2).cut, config_version: 1 }, settings: { ...page().settings, timezone: 'Asia/Tokyo' } };
      f.setHead(next); return { settings: next.settings };
    }
    if (url === '/api/v3/view') return read;
  });
  await f.source.refresh(); hold = true;
  const refreshing = f.source.refresh();
  const saving = f.source.mutate<{ timezone: string }>('settings', { timezone: 'Asia/Tokyo', timezoneMode: 'manual' }, 'PATCH');
  await tick(); assert.equal(saved, true);
  earlierRead.resolve(page()); await refreshing; const result = await saving;
  assert.deepEqual(f.calls.map(call => call.url), ['/api/v3/view', '/api/v3/view', '/api/v3/settings', '/api/v3/view']);
  assert.equal(result.data.timezone, 'Asia/Tokyo');
  assert.equal(f.source.state().read?.cut.config_version, 1);
  assert.equal((await f.source.query<{ timezone: string }>('settings')).data.timezone, 'Asia/Tokyo');
});
