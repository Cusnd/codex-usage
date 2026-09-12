import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudSyncController, entityHash, type ChangeResponse, type SyncTransport } from '../web/cloud-sync/controller';
import { MemoryCloudCache, type ManifestEntry, type ReadLease } from '../web/cloud-sync/cache';
import type { SnapshotManifestPage, SyncEntity } from '../shared/sync-v3';

const cut = { dataset_epoch: 'prefetch-epoch', commit_seq: 1, deletion_version: 0, organization_version: 0, config_version: 0 };
const expires_at = new Date(Date.now() + 3600_000).toISOString();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class Transport implements SyncTransport {
  rows: SyncEntity[] = []; manifests: (string | null)[] = []; downloaded: string[] = []; reads = 0;
  async status() { return { user_id: 'prefetch-user', cut, mode: 'ready' }; }
  async read(scope: 'recent' | 'full'): Promise<ReadLease> { this.reads++; return { lease_id: 'prefetch-lease', cut, scope, expires_at, total_entities: this.rows.length, expected_entities: [{ kind: 'event', count: this.rows.length }] }; }
  async renew() { return { cut, expires_at }; }
  async manifest(id: string, cursor: string | null, _signal?: AbortSignal): Promise<SnapshotManifestPage> {
    this.manifests.push(cursor); const start = Number(cursor ?? 0), entries = this.rows.slice(start, start + 200).map(({ value: _, ...entry }) => entry);
    return { lease_id: id, cut, scope: 'recent', expires_at, entities: entries, next_cursor: start + entries.length < this.rows.length ? String(start + entries.length) : null };
  }
  async entities(id: string, entries: ManifestEntry[], _signal?: AbortSignal) {
    this.downloaded.push(...entries.map(entry => entry.id)); return { lease_id: id, cut, expires_at, entities: entries.map(entry => this.rows[Number(entry.id)]) };
  }
  async changes(): Promise<ChangeResponse> { return { cut, commits: [], next_cursor: cut.commit_seq, more: false }; }
}
async function setup(transport = new Transport(), cache = new MemoryCloudCache()) {
  if (!transport.rows.length) {
    const value = { total: '9007199254740993' }, hash = await entityHash(value);
    transport.rows = Array.from({ length: 201 }, (_, i) => ({ kind: 'event', id: String(i).padStart(4, '0'), value, hash, revision: 1 }));
  }
  const controller = new CloudSyncController({ transport, cache, identity: { origin: 'https://fixture.invalid', userId: 'prefetch-user', deviceIds: [] }, autoFull: false });
  return { controller, cache, transport };
}

test('one manifest page overlaps current entity download without advancing the saved cursor or coverage', async () => {
  const { controller, transport } = await setup(), bodyStarted = deferred(), bodyRelease = deferred();
  transport.rows = Array.from({ length: 601 }, (_, i) => ({ ...transport.rows[0], id: String(i).padStart(4, '0') }));
  const original = transport.entities.bind(transport);
  transport.entities = async (...args) => { bodyStarted.resolve(); await bodyRelease.promise; return original(...args); };
  const pending = controller.trigger('initial'); await bodyStarted.promise;
  assert.deepEqual(transport.manifests, [null, '200']);
  assert.equal(controller.state().baseline?.cursor, null); assert.equal(controller.state().activeLease, null); assert.equal(controller.state().coverage, null);
  bodyRelease.resolve(); await pending;
  assert.equal(controller.state().coverage?.entities, 601); assert.equal(new Set(transport.downloaded).size, 601); assert.equal(transport.downloaded.length, 601);
});

test('a wrong cut in the prefetched second page is rejected and retry reuses only verified current-page bodies', async () => {
  const { controller, cache, transport } = await setup(), original = transport.manifest.bind(transport);
  let corrupt = true;
  transport.manifest = async (...args) => { const page = await original(...args); return args[1] === '200' && corrupt ? { ...page, cut: { ...cut, commit_seq: 2 } } : page; };
  await assert.rejects(controller.trigger('initial'), /fixed cut/);
  assert.equal(controller.state().activeLease, null); assert.equal(controller.state().baseline?.cursor, '200'); assert.equal(transport.downloaded.length, 200);
  controller.dispose(); corrupt = false; const resumed = (await setup(transport, cache)).controller; await resumed.trigger('initial');
  assert.equal(transport.reads, 1); assert.deepEqual(transport.manifests, [null, '200', '200']); assert.equal(transport.downloaded.length, 201);
});

test('an entity failure aborts and observes the outstanding prefetch before restart', async () => {
  const { controller, cache, transport } = await setup(), originalManifest = transport.manifest.bind(transport), originalEntities = transport.entities.bind(transport);
  let fail = true, outstanding = 0, aborted = false;
  transport.manifest = async (id, cursor, signal) => {
    if (cursor !== '200' || !fail) return originalManifest(id, cursor, signal);
    outstanding++;
    try { await new Promise<void>((_resolve, reject) => { const abort = () => { aborted = true; reject(signal!.reason); }; signal!.addEventListener('abort', abort, { once: true }); if (signal!.aborted) abort(); }); }
    finally { outstanding--; }
    return originalManifest(id, cursor, signal);
  };
  transport.entities = async (...args) => { if (fail) throw new Error('entity interrupted'); return originalEntities(...args); };
  await assert.rejects(controller.trigger('initial'), /entity interrupted/);
  assert.equal(outstanding, 0); assert.equal(aborted, true); assert.equal(controller.state().activeLease, null);
  controller.dispose(); fail = false; await (await setup(transport, cache)).controller.trigger('initial');
  assert.equal(transport.reads, 1); assert.equal(transport.downloaded.length, 201);
});

test('deletion during a late prefetch cannot restore the cleared namespace or publish its cut', async () => {
  const { controller, cache, transport } = await setup(), prefetched = deferred(), release = deferred(), original = transport.manifest.bind(transport);
  transport.manifest = async (...args) => { const page = await original(...args); if (args[1] === '200') { prefetched.resolve(); await release.promise; } return page; };
  const attempt = controller.trigger('initial'); await prefetched.promise;
  await controller.invalidateForDeletion(); release.resolve();
  await assert.rejects(attempt, /cache reset/); const state = await cache.state(controller.namespace);
  assert.equal(state?.activeLease, null); assert.equal(state?.baseline, null); assert.equal(state?.coverage, null);
  assert.equal((await cache.stages(controller.namespace, 'prefetch-lease')).length, 0);
});

for (const phase of ['baseline', 'delta'] as const) test(`deletion during ${phase} content hashing cannot write verified old data into the new cache generation`, async t => {
  const { controller, cache, transport } = await setup(), hashing = deferred(), release = deferred();
  if (phase === 'delta') {
    await controller.trigger('initial');
    const manifest = transport.manifest.bind(transport);
    transport.manifest = async (...args) => ({ ...await manifest(...args), scope: 'full' });
    await controller.trigger('automatic');
    const target = { ...cut, commit_seq: 2 }, value = { total: '9007199254740994' };
    const entity = { ...transport.rows[0], revision: 2, value, hash: await entityHash(value) };
    transport.status = async () => ({ user_id: 'prefetch-user', cut: target, mode: 'ready' });
    transport.read = async scope => ({ lease_id: 'delta-lease', scope, cut: target, expires_at, total_entities: 201, expected_entities: [{ kind: 'event', count: 201 }] });
    transport.changes = async () => ({ cut: target, commits: [{ commit_seq: 2, entities: [entity], deleted: [] }], next_cursor: 2, more: false });
  }
  const original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof original>) => { hashing.resolve(); await release.promise; return original(...args); });
  const attempt = controller.trigger(phase === 'baseline' ? 'initial' : 'automatic'); await hashing.promise;
  await controller.invalidateForDeletion(); release.resolve();
  await assert.rejects(attempt, /cache reset/);
  const state = await cache.state(controller.namespace);
  assert.equal(state?.baseline, null); assert.equal(state?.deltaLease, null); assert.equal(state?.activeLease, null); assert.equal(state?.appliedCommitSeq, 0);
  assert.equal((await cache.stages(controller.namespace, phase === 'baseline' ? 'prefetch-lease' : 'delta-lease')).length, 0);
  assert.equal((await cache.entities(controller.namespace, cut.dataset_epoch, [transport.rows[0]]))[0], undefined);
});

test('disposing a source aborts its prefetch and prevents body persistence after asynchronous hashing', async t => {
  const { controller, cache, transport } = await setup(), hashing = deferred(), release = deferred(), originalManifest = transport.manifest.bind(transport);
  let aborted = false;
  transport.manifest = async (id, cursor, signal) => {
    if (cursor !== '200') return originalManifest(id, cursor, signal);
    await new Promise<void>((_resolve, reject) => { const stop = () => { aborted = true; reject(signal!.reason); }; signal!.addEventListener('abort', stop, { once: true }); if (signal!.aborted) stop(); });
    return originalManifest(id, cursor, signal);
  };
  const original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof original>) => { hashing.resolve(); await release.promise; return original(...args); });
  const attempt = controller.trigger('initial'); await hashing.promise; controller.dispose(); release.resolve();
  await assert.rejects(attempt, { name: 'AbortError' });
  assert.equal(aborted, true); assert.equal((await cache.state(controller.namespace))?.activeLease, null);
  assert.equal((await cache.stages(controller.namespace, 'prefetch-lease')).some(row => row.type === 'entity' && row.entity), false);
});
