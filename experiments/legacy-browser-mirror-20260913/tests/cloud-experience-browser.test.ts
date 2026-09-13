import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudUsageDataSource, OfflineCacheMiss } from '../browser/data-source.js';
import { CloudSyncController, SyncError } from '../browser/controller.js';
import { emptyState } from '../browser/cache.js';
import { setupExperience, identity, cut } from '../scripts/cloud-experience-browser-fixture.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const response = (data: unknown, target = cut) => ({ data, meta: { source: 'cloud', updatedAt: null, timezone: 'UTC', warnings: [], cut: target } });

test('a cold fixed-cut query is usable and durable before any entity body completes, including offline reopen and same-cut full promotion', async () => {
  const { controller, cache, transport } = await setupExperience(600), bodyStarted = deferred(), release = deferred();
  const original = transport.entities.bind(transport);
  transport.entities = async (...args) => { bodyStarted.resolve(); await release.promise; return original(...args); };
  let requests = 0;
  const source = new CloudUsageDataSource(controller, async <T>() => { requests++; return response({ totalTokens: '9007199254740993' }) as T; }, () => true);
  const syncing = controller.trigger('initial');
  const page = await source.query('local/summary'); await bodyStarted.promise;
  assert.deepEqual(page.data, { totalTokens: '9007199254740993' });
  assert.equal(controller.state().phase, 'recent_loading'); assert.equal(controller.state().coverage, null); assert.equal(controller.state().activeLease, null);
  assert.equal(controller.state().appliedCommitSeq, 0); assert.equal((await cache.entities(controller.namespace, cut.dataset_epoch, transport.rows)).filter(Boolean).length, 0);
  const clock = source.clock(), revision = source.revision(), captured = source.capture();
  const reopened = new CloudSyncController({ cache, identity, transport: transport.http(), now: () => transport.now });
  const offline = new CloudUsageDataSource(reopened, async <T>(): Promise<T> => { throw Error('offline must not fetch'); }, () => false);
  assert.deepEqual((await offline.query('local/summary')).data, page.data);
  await assert.rejects(offline.query('local/summary', { model: 'uncached' }), OfflineCacheMiss);
  for (const changed of [{ ...identity, userId: 'other-user' }, { ...identity, deviceIds: ['another-device'] }]) {
    const other = new CloudUsageDataSource(new CloudSyncController({ cache, identity: changed, transport: transport.http() }), undefined, () => false);
    await assert.rejects(other.query('local/summary'), OfflineCacheMiss);
  }
  transport.now += 5000; release.resolve(); await syncing;
  assert.equal(controller.state().phase, 'full_ready'); assert.equal(controller.state().coverage?.entities, 600);
  assert.equal(source.clock(), clock); assert.equal(source.revision(), revision); assert.deepEqual(source.capture().lease?.cut, captured.lease?.cut);
  assert.deepEqual((await source.query('local/summary')).data, page.data); assert.equal(requests, 1);
  controller.dispose(); reopened.dispose();
});

test('a late cold query cannot restore history deleted by another tab', async () => {
  const { controller, cache, transport } = await setupExperience(200), bodyRelease = deferred(), queryStarted = deferred(), queryRelease = deferred();
  const original = transport.entities.bind(transport);
  transport.entities = async (...args) => { await bodyRelease.promise; return original(...args); };
  const source = new CloudUsageDataSource(controller, async <T>() => { queryStarted.resolve(); await queryRelease.promise; return response({ old: true }) as T; });
  const syncing = controller.trigger('initial').catch(error => error);
  const query = source.query('local/summary'); await queryStarted.promise;
  await cache.write(controller.state(), { state: emptyState(controller.namespace), resetUser: true });
  queryRelease.resolve(); await assert.rejects(query, { code: 'VIEW_CHANGED' });
  bodyRelease.resolve(); await syncing;
  const reopened = new CloudUsageDataSource(new CloudSyncController({ cache, identity, transport: transport.http() }), undefined, () => false);
  await assert.rejects(reopened.query('local/summary'), OfflineCacheMiss);
  assert.equal((await cache.state(controller.namespace))?.activeLease, null); controller.dispose();
});

test('reopening a cold cached query after deletion completes clears all prior device scopes', async () => {
  const { controller, cache, transport } = await setupExperience();
  const lease = await transport.read('recent', []), initial = emptyState(controller.namespace);
  const baseline = { lease, cursor: null, started: false, counts: {}, last_key: null, page: null };
  await cache.write(initial, { state: { ...initial, baseline, phase: 'recent_loading' } });
  const query = { key: 'before-deletion', cut, response: response({ old: true }), cachedAt: new Date().toISOString() };
  await cache.putQuery(controller.namespace, query);
  const sibling = new CloudSyncController({ cache, identity: { ...identity, deviceIds: ['other'] }, transport: transport.http() });
  const otherState = emptyState(sibling.namespace); await cache.write(otherState, { state: { ...otherState, baseline, phase: 'recent_loading' } });
  await cache.putQuery(sibling.namespace, query);
  transport.head = { ...cut, deletion_version: 1 };
  await controller.trigger('initial');
  assert.equal(await cache.query(controller.namespace, query.key), undefined); assert.equal(await cache.state(sibling.namespace), null);
  assert.equal(await cache.query(sibling.namespace, query.key), undefined); assert.equal(controller.queryLease()?.cut.deletion_version, 1);
  controller.dispose(); sibling.dispose();
});

test('an expired cold checkpoint recovers a verified replacement before its entity download completes', async () => {
  const { controller, cache, transport } = await setupExperience(200, false), release = deferred();
  const old = await transport.read('recent', []), initial = emptyState(controller.namespace);
  await cache.write(initial, { state: { ...initial, phase: 'recent_loading', baseline: { lease: old, cursor: null, started: false, counts: {}, last_key: null, page: null } } });
  transport.now = Date.parse(old.expires_at) - 30_000; transport.invalid.add(old.lease_id);
  const original = transport.entities.bind(transport); transport.entities = async (...args) => { await release.promise; return original(...args); };
  const source = new CloudUsageDataSource(controller, async <T>() => response({ exact: '123' }) as T);
  const page = await source.query('local/summary');
  assert.deepEqual(page.data, { exact: '123' }); assert.notEqual(source.capture().lease?.lease_id, old.lease_id);
  assert.equal(controller.state().activeLease, null); assert.equal(controller.state().coverage, null); assert.equal(transport.counts.renew, 1);
  release.resolve(); await controller.settle(); controller.dispose();
});

test('six near-expiry queries share one renewal and stale captures reuse the renewed expiration', async () => {
  const { controller, transport } = await setupExperience(); await controller.trigger('initial');
  const old = controller.state().activeLease!; transport.now = Date.parse(old.expires_at) - 30_000; transport.delayMs = 5;
  const source = new CloudUsageDataSource(controller, async <T>() => response({ totalTokens: '100' }) as T);
  const view = source.capture();
  await Promise.all(Array.from({ length: 6 }, (_, index) => source.query('local/summary', { model: String(index) }, undefined, view)));
  await source.query('local/summary', { model: 'later' }, undefined, view);
  assert.equal(transport.counts.renew, 1); controller.dispose();
});

test('six invalid leases recover once without rewalking a full manifest or mixing cuts', async () => {
  const { controller, transport } = await setupExperience(); await controller.trigger('initial');
  const old = controller.state().activeLease!; transport.now = Date.parse(old.expires_at) - 30_000; transport.invalid.add(old.lease_id); transport.delayMs = 5;
  const before = { ...transport.counts }, urls: string[] = [];
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => { urls.push(url); return response({ exact: '9007199254740993' }) as T; });
  const view = source.capture();
  const values = await Promise.all(Array.from({ length: 6 }, (_, index) => source.query('local/summary', { model: String(index) }, undefined, view)));
  assert.ok(values.every(value => (value.data as { exact: string }).exact === '9007199254740993'));
  assert.equal(transport.counts.renew - before.renew, 1); assert.equal(transport.counts.status - before.status, 1); assert.equal(transport.counts.read - before.read, 1);
  assert.equal(transport.counts.manifest, before.manifest); assert.notEqual(controller.state().activeLease?.lease_id, old.lease_id);
  assert.ok(urls.every(url => !url.includes('lease_id=' + old.lease_id))); controller.dispose();
});

test('recovery publishes a changed cut for a new page but rejects every old captured view', async () => {
  const { controller, transport } = await setupExperience(); await controller.trigger('initial');
  const old = controller.state().activeLease!; transport.now = Date.parse(old.expires_at) - 30_000; transport.invalid.add(old.lease_id);
  transport.head = { ...cut, config_version: 1 };
  let requests = 0;
  const source = new CloudUsageDataSource(controller, async <T>() => { requests++; return response({ current: true }, transport.head) as T; });
  const view = source.capture(), revision = source.revision();
  await assert.rejects(source.query('local/summary', {}, undefined, view), { code: 'VIEW_CHANGED' });
  assert.notEqual(source.revision(), revision); assert.equal(requests, 0);
  assert.deepEqual((await source.query('local/summary')).data, { current: true }); controller.dispose();
});

test('a deleting status during expired-lease recovery clears the saved user instead of retrying old queries', async () => {
  const { controller, cache, transport } = await setupExperience(); await controller.trigger('initial');
  const old = controller.state().activeLease!; transport.now = Date.parse(old.expires_at) - 30_000; transport.invalid.add(old.lease_id); transport.mode = 'deleting';
  const source = new CloudUsageDataSource(controller, async <T>(): Promise<T> => { throw Error('deleted query must not reach network'); });
  await assert.rejects(source.query('local/summary'), { code: 'HISTORY_UPDATING' });
  assert.equal((await cache.state(controller.namespace))?.activeLease, null); assert.equal(controller.queryLease(), null); controller.dispose();
});

test('coalesced usage and project reads keep independent cancellation for each page', async () => {
  const { controller } = await setupExperience(); await controller.trigger('initial');
  const started = deferred(), release = deferred(), first = new AbortController(); let requests = 0, projects = 0, transportAborted = false;
  const source = new CloudUsageDataSource(controller, async <T>(url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v3/projects')) { projects++; return { lease_id: controller.queryLease()!.lease_id, cut, projects: [{ id: 'p', name: 'Project' }], aliases: {} } as T; }
    requests++; init?.signal?.addEventListener('abort', () => { transportAborted = true; }, { once: true }); started.resolve(); await release.promise;
    return response({ project: 'p', totalTokens: '123' }) as T;
  });
  const cancelled = source.query('local/summary', { model: 'same' }, first.signal), kept = source.query('local/summary', { model: 'same' });
  await started.promise; first.abort(); await assert.rejects(cancelled, { name: 'AbortError' }); release.resolve();
  assert.deepEqual((await kept).data, { project: 'p', totalTokens: '123' }); assert.equal(transportAborted, false); assert.equal(requests, 1); assert.equal(projects, 1);
  controller.dispose();
});

test('the transport cancels a shared request only after its final subscriber leaves', async () => {
  const { controller } = await setupExperience(); await controller.trigger('initial');
  const started = deferred(), a = new AbortController(), b = new AbortController(); let aborted = 0;
  const source = new CloudUsageDataSource(controller, async <T>(_url: string, init?: RequestInit): Promise<T> => {
    started.resolve(); return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => { aborted++; reject(init.signal!.reason); }, { once: true }));
  });
  const one = source.query('local/summary', {}, a.signal), two = source.query('local/summary', {}, b.signal);
  await started.promise; a.abort(); await assert.rejects(one, { name: 'AbortError' }); assert.equal(aborted, 0);
  b.abort(); await assert.rejects(two, { name: 'AbortError' }); assert.equal(aborted, 1); controller.dispose();
});

test('500-entry manifests use at most two concurrent 100-entity requests per wave and a failed sibling never promotes coverage', async () => {
  const { controller, transport } = await setupExperience(1000, false, 2); transport.recentCount = 1000;
  await controller.trigger('initial'); assert.equal(transport.counts.manifest, 2); assert.equal(transport.counts.entities, 10); assert.equal(transport.maximumBodies, 2);
  assert.equal(controller.state().coverage?.entities, 1000); controller.dispose();
  const failure = await setupExperience(200, false), first = deferred(); let aborted = false;
  failure.transport.entities = async (_id, entries, signal) => {
    if (entries[0].id === '000000') { await first.promise; throw new SyncError('first body failed'); }
    first.resolve(); await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    throw Error('unreachable');
  };
  await assert.rejects(failure.controller.trigger('initial'), /first body failed/);
  assert.equal(aborted, true); assert.equal(failure.controller.state().coverage, null); assert.equal(failure.controller.state().activeLease, null);
  assert.equal((await failure.cache.entities(failure.controller.namespace, cut.dataset_epoch, failure.transport.rows)).filter(Boolean).length, 0); failure.controller.dispose();
});
