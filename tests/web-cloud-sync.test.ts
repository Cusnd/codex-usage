import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudSyncController, entityHash, SyncError, type SyncTransport, type ChangeResponse } from '../web/cloud-sync/controller';
import { MemoryCloudCache, emptyState, namespaceOf, CacheConflict, type CacheWrite, type CacheState, type ReadLease, type ManifestEntry } from '../web/cloud-sync/cache';
import { CloudUsageDataSource, OfflineCacheMiss } from '../web/data-source';
import { namesFromProjects, referencedProjectIds } from '../web/cloud-sync/project-labels';
import { stableJson, type SyncEntity, type SyncCut, type SnapshotManifestPage } from '../shared/sync-v3';
import { USAGE_QUERY_REVISION } from '../shared/query-revision';
import type { ApiResponse, Settings } from '../shared/contracts';

const identity = { origin: 'https://usage.example', userId: 'github:42', deviceIds: [] as string[] };
const cut = (commit_seq = 1): SyncCut => ({ dataset_epoch: 'epoch-a', commit_seq, deletion_version: 0, organization_version: 0, config_version: 0 });
const now = Date.parse('2026-09-11T15:00:00Z'), expires_at = new Date(now + 15 * 60_000).toISOString();
const entity = async (id: string, value: unknown = { total: 42 }, revision = 1): Promise<SyncEntity> => ({ kind: 'event', id, value, revision, hash: await entityHash(value) });
const refs = (rows: SyncEntity[]) => rows.map(({ value: _, ...ref }) => ref);

class Transport implements SyncTransport {
  head = cut(); mode = 'ready'; rows: SyncEntity[] = []; recent: SyncEntity[] | undefined;
  settings:Settings|undefined;
  reads: { scope: string; from?: string; lease: ReadLease }[] = []; manifests: (string | null)[] = []; fetched: string[] = []; renewals: string[] = [];
  leases = new Map<string, { lease: ReadLease; rows: SyncEntity[] }>();
  failManifestAt: string | null | undefined; failEntityOnce = false; manifestPageSize = 200;
  change: ChangeResponse | ((after: number) => ChangeResponse) = { cut: cut(), commits: [], next_cursor: 1, more: false };
  async status() { return { user_id: identity.userId, cut: this.head, mode: this.mode }; }
  async read(scope: 'recent' | 'full', _ids: string[], from?: string) {
    const rows = structuredClone(scope === 'recent' ? this.recent ?? this.rows : this.rows), leaseCut = from ? this.leases.get(from)!.lease.cut : this.head;
    const counts = new Map<SyncEntity['kind'], number>(); rows.forEach(row => counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1));
    const lease: ReadLease = { lease_id: `lease-${this.reads.length}`, cut: { ...leaseCut }, scope, expires_at,...this.settings?{settings:this.settings}:{},
      expected_entities: [...counts].map(([kind, count]) => ({ kind, count })), total_entities: rows.length, coverage: { sources: [{ source_id: 'log', generation: 1, complete: true }] } };
    this.reads.push({ scope, from, lease }); this.leases.set(lease.lease_id, { lease, rows }); return structuredClone(lease);
  }
  async renew(lease: string) { this.renewals.push(lease); return { expires_at: new Date(now + 30 * 60_000).toISOString(), cut: this.leases.get(lease)!.lease.cut }; }
  async manifest(id: string, cursor: string | null): Promise<SnapshotManifestPage> {
    this.manifests.push(cursor);
    if (this.failManifestAt !== undefined && this.failManifestAt === cursor) { this.failManifestAt = undefined; throw new Error('network interrupted'); }
    const { lease, rows } = this.leases.get(id)!, offset = Number(cursor ?? 0), entries = refs(rows.slice(offset, offset + this.manifestPageSize));
    return { lease_id: id, cut: lease.cut, scope: lease.scope, entities: entries, next_cursor: offset + entries.length < rows.length ? String(offset + entries.length) : null, expires_at };
  }
  async entities(id: string, entries: ManifestEntry[]) {
    if (this.failEntityOnce) { this.failEntityOnce = false; throw new Error('entity network interrupted'); }
    this.fetched.push(...entries.map(entry => entry.id));
    const { lease, rows } = this.leases.get(id)!;
    return { lease_id: id, cut: lease.cut, entities: entries.map(entry => rows.find(row => row.id === entry.id && row.kind === entry.kind)!), expires_at };
  }
  async changes(_lease: ReadLease, after: number) { return typeof this.change === 'function' ? this.change(after) : this.change; }
}
const setup = (transport = new Transport(), cache = new MemoryCloudCache(), autoFull = true) => ({ transport, cache,
  controller: new CloudSyncController({ transport, cache, identity, now: () => now, autoFull }) });
const response = <T>(data: T, value: SyncCut = cut()): ApiResponse<T> => ({ data, meta: { source: 'cloud', updatedAt: null, timezone: 'UTC', warnings: [], cut: value } } as ApiResponse<T>);

test('minute or focus settings reads follow the browser zone without advancing the cut or the shared account cache',async()=>{
  const t=new Transport();t.settings={localInterval:0,accountInterval:0,timezoneMode:'system',timezone:'UTC'};const {controller}=setup(t);await controller.trigger('initial');const reads=t.reads.length;let zone='America/Los_Angeles',accounts=0;const urls:string[]=[];
  const source=new CloudUsageDataSource(controller,async<T>(url:string)=>{urls.push(url);if(url==='/api/v3/accounts'){accounts++;return {user_id:identity.userId,accounts:[]} as T;}const timezone=new URL(url,identity.origin).searchParams.get('timezone')!;return response(url.startsWith('/api/v3/settings')?{...t.settings,timezone}:{day:timezone}) as T;},()=>true,()=>zone);
  assert.equal((await source.query<Settings>('settings')).data.timezone,'America/Los_Angeles');await source.query('local/trend');await source.query('account/cloud');const previous=source.capture(),revision=source.revision();zone='Asia/Tokyo';
  assert.notEqual(source.revision(),revision);assert.equal((await source.query<Settings>('settings')).data.timezone,'Asia/Tokyo');assert.deepEqual((await source.query('local/trend')).data,{day:'Asia/Tokyo'});await source.query('account/cloud');assert.equal(accounts,1);assert.equal(t.reads.length,reads);
  assert.equal(urls.filter(url=>url.includes('local/trend')).length,2);await assert.rejects(source.query('local/trend',{},undefined,previous),/time zone changed/);
});

test('manual cloud timezone keeps its query cache and view revision when the browser timezone changes',async()=>{
  const t=new Transport();t.settings={localInterval:0,accountInterval:0,timezoneMode:'manual',timezone:'Europe/London'};const {controller}=setup(t);await controller.trigger('initial');let zone='America/Los_Angeles';const urls:string[]=[];
  const source=new CloudUsageDataSource(controller,async<T>(url:string)=>{urls.push(url);return response({day:'fixed'}) as T;},()=>true,()=>zone);await source.query('local/trend');const revision=source.revision();zone='Asia/Tokyo';await source.query('local/trend');assert.equal(source.revision(),revision);assert.equal(urls.length,1);assert.equal(new URL(urls[0],identity.origin).searchParams.get('timezone'),'Europe/London');
});

test('first recent view is usable before full completion; full shares its exact cut and reuses hashes', async () => {
  const t = new Transport(); t.rows = [await entity('a'), await entity('z')]; t.recent = [t.rows[0]];
  const { controller, cache } = setup(t), phases: string[] = [];
  controller.subscribe(() => { phases.push(controller.state().phase); if (controller.state().phase === 'recent_ready') t.head = cut(2); });
  await controller.trigger('initial');
  assert.deepEqual(t.reads.map(r => [r.scope, r.from]), [['recent', undefined], ['full', 'lease-0']]);
  assert.deepEqual(controller.state().activeLease?.cut, cut()); assert.equal(controller.state().phase, 'full_ready');
  assert.ok(phases.includes('recent_ready')); assert.deepEqual(t.fetched, ['a', 'z']);
  assert.equal((await cache.entities(controller.namespace, 'epoch-a', t.rows)).filter(Boolean).length, 2);
  assert.deepEqual(controller.state().coverage?.sources, t.reads[0].lease.coverage);
});

test('manifest cursor and downloaded chunks resume after browser restart', async () => {
  const t = new Transport(); t.rows = [await entity('a'), await entity('b'), await entity('c')]; t.manifestPageSize = 1; t.failManifestAt = '1';
  const { controller, cache } = setup(t, undefined, false);
  await assert.rejects(controller.trigger('initial'), /network interrupted/);
  assert.equal(controller.state().activeLease, null); assert.equal(controller.state().baseline?.cursor, '1');
  controller.dispose(); const restarted = setup(t, cache, false).controller; await restarted.trigger('initial');
  assert.equal(t.reads.length, 1); assert.deepEqual(t.manifests, [null, '1', '1', '2']); assert.deepEqual(t.fetched, ['a', 'b', 'c']);
  assert.equal(restarted.state().phase, 'recent_ready'); assert.equal((await cache.stages(restarted.namespace, 'lease-0')).length, 0);
});

test('saved manifest page resumes entity download without requesting that manifest again', async () => {
  const t = new Transport(); t.rows = [await entity('a')]; t.failEntityOnce = true; const { controller, cache } = setup(t, undefined, false);
  await assert.rejects(controller.trigger('initial'), /entity network/);
  await setup(t, cache, false).controller.trigger('initial'); assert.deepEqual(t.manifests, [null]); assert.deepEqual(t.fetched, ['a']);
});

test('wrong content hashes and incomplete manifests never promote coverage or advance applied cursor', async () => {
  const t = new Transport(); t.rows = [{ ...await entity('a'), value: { corrupted: true } }]; const { controller } = setup(t);
  await assert.rejects(controller.trigger('initial'), /hash mismatch/); assert.equal(controller.state().activeLease, null); assert.equal(controller.state().appliedCommitSeq, 0);
  const short = new Transport(); short.rows = [await entity('a'), await entity('b')]; short.manifest = async id => ({ lease_id: id, scope: 'recent', cut: cut(), entities: refs(short.rows.slice(0, 1)), next_cursor: null, expires_at });
  const other = setup(short).controller; await assert.rejects(other.trigger('initial'), /Incomplete snapshot/); assert.equal(other.state().coverage, null);
});

test('periodic deltas atomically apply complete commits and explicit refresh checks a full manifest', async () => {
  const t = new Transport(); t.rows = [await entity('a')]; const { controller, cache } = setup(t); await controller.trigger('initial');
  const updated = await entity('a', { total: 99 }, 2); t.rows = [updated]; t.head = cut(2);
  t.change = { cut: t.head, commits: [{ commit_seq: 2, entities: [updated], deleted: [], entity_count: 1, complete: true }], next_cursor: 2, more: false };
  await controller.trigger('automatic'); assert.equal(controller.state().appliedCommitSeq, 2); assert.equal(controller.state().receivedCommitSeq, 2);
  assert.equal((await cache.entities(controller.namespace, 'epoch-a', [updated]))[0]?.revision, 2);
  const manifests = t.manifests.length, fetched = t.fetched.length;
  await controller.trigger('manual'); assert.equal(t.manifests.length, manifests + 1); assert.equal(t.fetched.length, fetched);
});

test('unchanged automatic sync avoids new leases and manifests, including filtered devices, while manual refresh verifies them', async () => {
  for (const deviceIds of [[], ['windows']]) {
    const t = new Transport(); t.rows = [await entity('a')]; const cache = new MemoryCloudCache();
    const controller = new CloudSyncController({ transport: t, cache, identity: { ...identity, deviceIds }, now: () => now });
    await controller.trigger('initial'); const reads = t.reads.length, manifests = t.manifests.length, viewAt = controller.state().viewAt;
    for (let i = 0; i < 10; i++) await controller.trigger('automatic');
    assert.equal(t.reads.length, reads); assert.equal(t.manifests.length, manifests); assert.equal(controller.state().viewAt, viewAt);
    await controller.trigger('manual'); assert.equal(t.reads.length, reads + 1); assert.equal(t.manifests.length, manifests + 1);
  }
});

test('an unchanged automatic cut obtains a fresh lease near expiration and cannot skip a deletion', async () => {
  const t = new Transport(); let clock = now; const cache = new MemoryCloudCache();
  const controller = new CloudSyncController({ transport: t, cache, identity, now: () => clock });
  await controller.trigger('initial'); const reads = t.reads.length;
  clock = Date.parse(expires_at) - 30_000; await controller.trigger('automatic'); assert.equal(t.reads.length, reads + 1);
  t.mode = 'deleting'; await assert.rejects(controller.trigger('automatic'), /deletion/);
  assert.equal(controller.state().activeLease, null); assert.equal(controller.state().coverage, null);
});

test('crash between received and applied commit restarts from staged data without losing the cursor', async () => {
  class InterruptedCache extends MemoryCloudCache {
    fail = false;
    override async write(state: CacheState, change: CacheWrite) { if (this.fail && change.entities?.length) { this.fail = false; throw new Error('disk interrupted'); } return super.write(state, change); }
  }
  const t = new Transport(), cache = new InterruptedCache(); t.rows = [await entity('a')]; const { controller } = setup(t, cache); await controller.trigger('initial');
  const updated = await entity('a', { total: 99 }, 2); t.head = cut(2); t.rows = [updated];
  t.change = { cut: t.head, commits: [{ commit_seq: 2, entities: [updated], deleted: [] }], next_cursor: 2, more: false }; cache.fail = true;
  await assert.rejects(controller.trigger('automatic'), /disk interrupted/); assert.equal(controller.state().receivedCommitSeq, 2); assert.equal(controller.state().appliedCommitSeq, 1);
  t.change = () => { throw new Error('staged commit should require no download'); };
  const restarted = setup(t, cache).controller; await restarted.trigger('initial'); assert.equal(restarted.state().appliedCommitSeq, 2); assert.deepEqual(restarted.state().activeLease?.cut, cut(2));
});

test('incomplete multi-chunk commit remains staged until every chunk is present', async () => {
  const t = new Transport(); t.rows = []; const { controller } = setup(t); await controller.trigger('initial');
  const a = await entity('a'), b = await entity('b'); t.rows = [a, b]; t.head = cut(2);
  t.change = { cut: t.head, commits: [{ commit_seq: 2, entities: [a], deleted: [], chunk_index: 0, chunk_count: 2, entity_count: 2, complete: false }], next_cursor: 2, more: false };
  await assert.rejects(controller.trigger('automatic'), /complete commit is still missing/); assert.equal(controller.state().receivedCommitSeq, 2); assert.equal(controller.state().appliedCommitSeq, 1);
  t.change = { cut: t.head, commits: [{ commit_seq: 2, entities: [b], deleted: [], chunk_index: 1, chunk_count: 2, entity_count: 2, complete: true }], next_cursor: 2, more: false };
  await controller.trigger('automatic'); assert.equal(controller.state().appliedCommitSeq, 2);
});

test('commit gaps and changed response cut are rejected without applying entities', async () => {
  const t = new Transport(); const { controller } = setup(t); await controller.trigger('initial'); t.head = cut(3);
  t.change = { cut: cut(3), commits: [{ commit_seq: 3, entities: [await entity('a')], deleted: [] }], next_cursor: 3, more: false };
  await assert.rejects(controller.trigger('automatic'), /commit gap/); assert.equal(controller.state().appliedCommitSeq, 1);
});

test('deletion clears every device scope for this user and leaves other users intact', async () => {
  const cache = new MemoryCloudCache(), t = new Transport(); t.rows = [await entity('a')]; const { controller } = setup(t, cache); await controller.trigger('initial');
  const scope = namespaceOf({ ...identity, deviceIds: ['device-a'] }), other = namespaceOf({ ...identity, userId: 'github:99' });
  for (const namespace of [scope, other]) await cache.write(emptyState(namespace), { state: { ...emptyState(namespace), activeLease: controller.state().activeLease }, entities: t.rows });
  t.mode = 'deleting'; await assert.rejects(controller.trigger('automatic'), /deletion is still in progress/);
  assert.equal((await cache.entities(controller.namespace, 'epoch-a', t.rows))[0], undefined); assert.equal(await cache.state(scope), null); assert.ok(await cache.state(other));
  assert.equal(controller.state().activeLease, null);
});

test('cache compare-and-swap prevents two tabs from advancing one checkpoint', async () => {
  const cache = new MemoryCloudCache(), initial = emptyState(namespaceOf(identity));
  await cache.write(initial, { state: initial }); await assert.rejects(cache.write(initial, { state: initial }), CacheConflict);
});

test('cached queries are exact, offline misses are explicit, and all online usage reads carry the same cut', async () => {
  const { controller } = setup(); await controller.trigger('initial'); let online = true; const urls: string[] = [];
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => { urls.push(url); return response({ rows: [1] }) as T; }, () => online);
  const first = await source.query('local/overview', { model: 'gpt-5', deviceIds: ['b', 'a', 'a'] }); assert.deepEqual(first.data, { rows: [1] });
  online = false; const cached = await source.query('local/overview', { deviceIds: ['a', 'b'], model: 'gpt-5' });
  assert.ok(cached.meta.warnings.some(w => w.includes('离线'))); assert.equal(urls.length, 1); assert.match(urls[0], /lease_id=lease-1/);
  await assert.rejects(source.query('local/overview', { model: 'gpt-6' }), OfflineCacheMiss);
  await assert.rejects(source.query('threads/a'), OfflineCacheMiss);
});

test('a new query algorithm excludes old credits DTOs at the same cut without discarding history or relabeling old units', async () => {
  const t = new Transport(); t.rows = [await entity('retained')];
  t.settings = { localInterval: 0, accountInterval: 0, timezoneMode: 'manual', timezone: 'UTC' };
  const { controller, cache } = setup(t); await controller.trigger('initial');
  const lease = controller.state().activeLease!, namespace = controller.namespace;
  const oldKey = stableJson([lease.cut, 'local/summary', { timezone: 'UTC' }]);
  const oldData = { cost: { amount: '1.155', currency: 'credits', complete: true, notes: [] } };
  await cache.putQuery(namespace, { key: oldKey, cut: lease.cut, response: response(oldData), cachedAt: new Date(now).toISOString() });
  let online = false; const urls: string[] = [];
  const newData = { cost: { amount: '0.0462', currency: 'USD', billingBasis: 'subscription', complete: true, notes: [] } };
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => { urls.push(url); return response(newData) as T; }, () => online);
  await assert.rejects(source.query('local/summary'), OfflineCacheMiss); assert.equal(urls.length, 0);
  assert.deepEqual((await cache.query(namespace, oldKey))?.response.data, oldData);
  online = true;
  assert.deepEqual((await source.query('local/summary')).data, newData); assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0], identity.origin).searchParams.get('lease_id'), lease.lease_id);
  assert.equal(JSON.parse(source.revision())[0], USAGE_QUERY_REVISION);
  const reads = t.reads.length; controller.dispose();
  const restarted = setup(t, cache).controller;
  const offline = new CloudUsageDataSource(restarted, async <T>(): Promise<T> => { throw new Error('offline must not fetch'); }, () => false);
  const saved = await offline.query('local/summary'); assert.deepEqual(saved.data, newData); assert.ok(saved.meta.warnings.some(w => w.includes('离线')));
  assert.equal(t.reads.length, reads); assert.deepEqual(restarted.state().activeLease?.cut, lease.cut);
  assert.equal(restarted.state().appliedCommitSeq, lease.cut.commit_seq);
  assert.deepEqual((await cache.entities(namespace, lease.cut.dataset_epoch, t.rows))[0], t.rows[0]);
  assert.deepEqual((await cache.query(namespace, oldKey))?.response.data, oldData); restarted.dispose();
});

test('wrong query cuts and page responses completing after deletion never enter the cache', async () => {
  const { controller } = setup(); await controller.trigger('initial');
  const source = new CloudUsageDataSource(controller, async <T>() => response({}, cut(9)) as T);
  await assert.rejects(source.query('local/overview'), /requested cut/);
  const slow = new CloudUsageDataSource(controller, async <T>() => { await controller.invalidateForDeletion(); return response({ old: true }) as T; });
  await assert.rejects(slow.query('local/overview'), /view changed/); assert.equal(controller.state().activeLease, null);
});

test('other-tab deletion invalidates an already cached query before it can be returned', async () => {
  const { controller, cache } = setup(); await controller.trigger('initial'); const source = new CloudUsageDataSource(controller, async <T>() => response({ old: true }) as T);
  await source.query('local/overview'); const persisted = (await cache.state(controller.namespace))!;
  await cache.write(persisted, { state: emptyState(controller.namespace), resetUser: true });
  await assert.rejects(source.query('local/overview'), /saved cloud view changed/);
});

test('a snapshot response arriving after local history invalidation cannot restore the deleted baseline', async () => {
  const t = new Transport(); t.rows = [await entity('a')]; const { controller } = setup(t);
  const original = t.manifest.bind(t); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.manifest = async (id, cursor) => { const page = await original(id, cursor); started(); await gate; return page; };
  const attempt = controller.trigger('initial'); await waiting; await controller.invalidateForDeletion(); release();
  await assert.rejects(attempt, /cache reset/); assert.equal(controller.state().activeLease, null); assert.equal(controller.state().baseline, null);
});

test('account observations ignore device filters and are never labeled with the usage cut', async () => {
  const { controller } = setup(); await controller.trigger('initial'); const urls: string[] = [];
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => { urls.push(url); return { user_id: identity.userId, accounts: [{ accountRef: 'account-a' }] } as T; });
  const value = await source.query('account/cloud', { deviceIds: ['a'] });
  assert.equal(urls[0], '/api/v3/accounts'); assert.equal((value.meta as unknown as { cut?: unknown }).cut, undefined);
  assert.equal((value.meta as unknown as { browserCache: { domain: string; queryCut?: unknown } }).browserCache.domain, 'account-observation');
  await source.query('account/cloud', { deviceIds: ['b'] }); assert.equal(urls.length, 1);
  source.invalidateAccounts(); await source.query('account/cloud'); assert.equal(urls.length, 2);
});

test('an account response after another tab switches login cannot replace this user cache', async () => {
  const { controller, cache } = setup(); let responseUser = identity.userId;
  const source = new CloudUsageDataSource(controller, async<T>() => ({ user_id: responseUser, accounts: [{ owner: responseUser }] }) as T);
  await source.query('account/cloud'); await source.mutate('refresh', { source: 'account' }); responseUser = 'different-login';
  await assert.rejects(source.query('account/cloud'), /user changed/);
  const offline = new CloudUsageDataSource(setup(undefined, cache).controller, undefined, () => false);
  assert.deepEqual((await offline.query('account/cloud')).data, [{ owner: identity.userId }]);
});

test('latest account observation survives reload and is shared across device scopes without a usage lease', async () => {
  const cache = new MemoryCloudCache(), first = setup(undefined, cache).controller; let value = 1, requests = 0;
  const source = new CloudUsageDataSource(first, async <T>() => { requests++; return { user_id: identity.userId, accounts: [{ revision: value }] } as T; });
  assert.deepEqual((await source.query('account/cloud', { deviceIds: ['a'] })).data, [{ revision: 1 }]);
  value = 2; await source.mutate('refresh', { source: 'account' });
  assert.deepEqual((await source.query('account/cloud')).data, [{ revision: 2 }]);
  const scoped = new CloudSyncController({ cache, identity: { ...identity, deviceIds: ['windows'] }, transport: new Transport(), now: () => now });
  const offline = new CloudUsageDataSource(scoped, async <T>(): Promise<T> => { throw Error('offline account must not fetch'); }, () => false);
  assert.equal(scoped.state().activeLease, null);
  const cached = await offline.query('account/cloud', { deviceIds: ['windows'] });
  assert.deepEqual(cached.data, [{ revision: 2 }]); assert.equal(requests, 2);
  assert.ok(cached.meta.warnings.some(w => w.includes('离线')));
  assert.equal((cached.meta as any).browserCache.queryCut, undefined);
});

test('account refresh persists a stale marker while retaining the latest available offline response', async () => {
  const { controller, cache } = setup(); const source = new CloudUsageDataSource(controller, async <T>() => ({ user_id: identity.userId, accounts: [{ latest: 1 }] }) as T);
  await source.query('account/cloud'); await source.mutate('refresh', { source: 'account' });
  const restarted = setup(undefined, cache).controller;
  const offline = new CloudUsageDataSource(restarted, async <T>(): Promise<T> => { throw Error('no network'); }, () => false);
  assert.deepEqual((await offline.query('account/cloud')).data, [{ latest: 1 }]);
  let requests = 0;
  const online = new CloudUsageDataSource(restarted, async <T>() => { requests++; return { user_id: identity.userId, accounts: [{ latest: 2 }] } as T; });
  assert.deepEqual((await online.query('account/cloud')).data, [{ latest: 2 }]); assert.equal(requests, 1);
});

test('account deletion atomically rejects old responses even when another scope recreates the cache', async () => {
  const { controller, cache } = setup();
  const stranger = new CloudSyncController({ cache, identity: { ...identity, userId: 'another-user' }, transport: new Transport() });
  const other = new CloudUsageDataSource(stranger, async <T>() => ({ user_id: 'another-user', accounts: [{ owner: 'other' }] }) as T);
  await other.query('account/cloud');
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const slow = new CloudUsageDataSource(controller, async <T>() => { started(); await gate; return { user_id: identity.userId, accounts: [{ old: true }] } as T; });
  const pending = slow.query('account/cloud'); await waiting;
  const scoped = new CloudSyncController({ cache, identity: { ...identity, deviceIds: ['windows'] }, transport: new Transport() });
  await scoped.invalidateForDeletion();
  const fresh = new CloudUsageDataSource(scoped, async <T>() => ({ user_id: identity.userId, accounts: [{ fresh: true }] }) as T);
  await fresh.query('account/cloud'); release();
  await assert.rejects(pending, /account view changed/);
  const offline = new CloudUsageDataSource(controller, async <T>(): Promise<T> => { throw Error('no network'); }, () => false);
  assert.deepEqual((await offline.query('account/cloud')).data, [{ fresh: true }]);
  assert.deepEqual((await other.query('account/cloud')).data, [{ owner: 'other' }]);
  const anotherOrigin = new CloudSyncController({ cache, identity: { ...identity, origin: 'https://another-origin.example' }, transport: new Transport() });
  await assert.rejects(new CloudUsageDataSource(anotherOrigin, undefined, () => false).query('account/cloud'), OfflineCacheMiss);
});

test('account refresh cannot let an older request replace the newly refreshed stable entry', async () => {
  const { controller } = setup(); let calls = 0, release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const source = new CloudUsageDataSource(controller, async <T>() => {
    if (++calls === 1) { started(); await gate; return { user_id: identity.userId, accounts: [{ value: 'old' }] } as T; }
    return { user_id: identity.userId, accounts: [{ value: 'new' }] } as T;
  });
  const old = source.query('account/cloud'); await waiting; await source.mutate('refresh', { source: 'account' });
  assert.deepEqual((await source.query('account/cloud')).data, [{ value: 'new' }]); release();
  await assert.rejects(old, /account view changed/);
  assert.deepEqual((await source.query('account/cloud')).data, [{ value: 'new' }]); assert.equal(calls, 2);
});

test('manual refresh all invalidates accounts and performs a full usage check', async () => {
  const { controller, transport } = setup(); await controller.trigger('initial');
  let accounts = 0;
  const source = new CloudUsageDataSource(controller, async <T>() => { accounts++; return { user_id: identity.userId, accounts: [] } as T; });
  await source.query('account/cloud'); const reads = transport.reads.length;
  await source.mutate('refresh', { source: 'all' }); await source.query('account/cloud');
  assert.equal(transport.reads.length, reads + 1); assert.equal(accounts, 2);
});

test('settings mutation normalizes the saved settings response for the existing settings page', async () => {
  const { controller } = setup(); await controller.trigger('initial');
  const saved = { localInterval: 0, accountInterval: 300, timezone: 'UTC', timezoneMode: 'manual' };
  const source = new CloudUsageDataSource(controller, async <T>() => ({ settings: saved, config_version: 1 }) as T);
  assert.deepEqual((await source.mutate('settings', { localInterval: 0 }, 'PATCH')).data, saved);
});

test('an expired page lease does not silently acquire a newer cut outside the configured interval', async () => {
  const { controller, transport } = setup(); await controller.trigger('initial'); const reads = transport.reads.length;
  const source = new CloudUsageDataSource(controller, async <T>(): Promise<T> => { throw new SyncError('Expired', 'BASELINE_REQUIRED', 409); });
  await assert.rejects(source.query('local/overview'), /请点击刷新/); assert.equal(transport.reads.length, reads);
});

test('canonical hash ignores object key order and cache namespaces normalize only the device set', async () => {
  assert.equal(await entityHash({ z: 1, nested: { b: 2, a: '😀' } }), await entityHash({ nested: { a: '😀', b: 2 }, z: 1 }));
  assert.equal(namespaceOf({ ...identity, deviceIds: ['b', 'a', 'b'] }), namespaceOf({ ...identity, deviceIds: ['a', 'b'] }));
  assert.notEqual(namespaceOf(identity), namespaceOf({ ...identity, origin: 'https://another.example' }));
});

test('same-cut cached project entities name every public DTO while preserving IDs and aliases', async () => {
  const logical = { subtype: 'logical', id: 'lp:one', project: { id: 'lp:one', name: '工作区 / 学习项目', members: ['pc:one'] } };
  const alias = { subtype: 'alias', id: 'lp:old', target: 'lp:one' };
  const t = new Transport(); t.rows = [
    { ...await entity('alias:lp:old', alias), kind: 'project' },
    { ...await entity('logical:lp:one', logical), kind: 'project' },
  ];
  const { controller, cache } = setup(t); await controller.trigger('initial'); const urls: string[] = [];
  const dto = { projects: ['lp:one', 'lp:old'], items: [{ project: 'lp:one' }], parents: [{ project: 'lp:old' }] };
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => { urls.push(url); return response(dto) as T; });
  assert.deepEqual((await source.query('local/filters')).data, dto); assert.equal(source.projectName('lp:one'), '工作区 / 学习项目');
  assert.equal(source.projectName('lp:old'), '工作区 / 学习项目'); assert.equal(urls.length, 1);
  const restarted = setup(t, cache).controller; await restarted.initialize();
  const offline = new CloudUsageDataSource(restarted, async <T>(): Promise<T> => { throw new Error('offline must not fetch'); }, () => false);
  assert.deepEqual((await offline.query('local/filters')).data, dto); assert.equal(offline.projectName('lp:old'), '工作区 / 学习项目');
});

test('project labels fall back only to their exact page lease and reject a newer organization cut', async () => {
  const { controller } = setup(); await controller.trigger('initial'); const urls: string[] = [];
  let wrong = true;
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => {
    urls.push(url); return (url.startsWith('/api/v3/projects')
      ? { cut: wrong ? cut(9) : cut(), lease_id: 'lease-1', projects: [{ id: 'lp:one', name: '项目旧名' }], aliases: {} }
      : response({ thread: { project: 'lp:one' } })) as T;
  });
  await assert.rejects(source.query('local/threads/one'), /Project labels do not match/); assert.equal(source.projectName('lp:one'), undefined);
  wrong = false; await source.query('local/threads/one'); assert.equal(source.projectName('lp:one'), '项目旧名');
  assert.equal(urls.filter(url => url.startsWith('/api/v3/projects')).every(url => url === '/api/v3/projects?lease_id=lease-1'), true);
});

test('partially applied delta entities cannot leak a newer project name into the old page cut', async () => {
  const { controller, cache } = setup(); await controller.trigger('initial');
  const value = { subtype: 'logical', id: 'lp:one', project: { id: 'lp:one', name: '新名称', members: [] } };
  const changed = { ...await entity('logical:lp:one', value, 2), kind: 'project' as const };
  await cache.write(controller.state(), { state: { ...controller.state(), appliedCommitSeq: 2 }, entities: [changed] });
  const source = new CloudUsageDataSource(controller, async <T>(url: string) => (url.startsWith('/api/v3/projects')
    ? { cut: cut(), lease_id: 'lease-1', projects: [{ id: 'lp:one', name: '旧名称' }], aliases: {} }
    : response({ project: 'lp:one' })) as T);
  await source.query('local/overview'); assert.equal(source.projectName('lp:one'), '旧名称');
});

test('project alias chains are cycle-safe and name tables include source IDs without changing opaque URL IDs', () => {
  const names = namesFromProjects([{ id: 'lp:new', name: '正式名称' }], { 'lp:old': 'lp:older', 'lp:older': 'lp:new', 'bad:a': 'bad:b', 'bad:b': 'bad:a' }, [{ id: 'pc:source', logical_project_id: 'lp:new' }]);
  assert.equal(names['lp:old'], '正式名称'); assert.equal(names['pc:source'], '正式名称'); assert.equal(names['bad:a'], undefined);
  const dto = { projects: ['lp:new'], thread: { project: 'lp:old' }, siblings: [{ project: 'lp:other' }], model: 'keep-model' };
  assert.deepEqual(referencedProjectIds(dto, 'lp:selected'), ['lp:selected', 'lp:new', 'lp:old', 'lp:other']);
  assert.equal(dto.thread.project, 'lp:old');
});
