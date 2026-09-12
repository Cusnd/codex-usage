import { IndexedDbCloudCache, emptyState, namespaceOf, CacheConflict, type ReadLease, type CacheState } from '../modules/sync/browser/cache.js';
import { entityHash } from '../modules/sync/browser/controller.js';
import type { SyncEntity } from '../modules/contracts/sync.js';

// This browser-only harness exercises actual IndexedDB transaction lifetimes, not the test double.
const result: { startedAt: string; browser: string; checks: { name: string; passed: boolean; error?: string }[]; complete: boolean } = {
  startedAt: new Date().toISOString(), browser: navigator.userAgent, checks: [], complete: false,
};
const output = document.createElement('pre'); output.id = 'results'; document.body.append(output);
const render = () => { output.textContent = JSON.stringify(result, null, 2); document.documentElement.dataset.result = result.complete ? result.checks.every(row => row.passed) ? 'passed' : 'failed' : 'running'; };
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const name = 'codex-usage-v3-test-' + crypto.randomUUID();
const namespace = namespaceOf({ origin: location.origin, userId: 'test-user', deviceIds: [] });
let cache = new IndexedDbCloudCache(indexedDB, name), state = emptyState(namespace);
const cut = { dataset_epoch: 'test-epoch', commit_seq: 1, deletion_version: 0, organization_version: 0, config_version: 0 };
const lease: ReadLease = { lease_id: 'one', scope: 'full', cut, total_entities: 2, expected_entities: [{ kind: 'event', count: 2 }], expires_at: new Date(Date.now() + 60_000).toISOString() };
const make = async (id: string, value: unknown, revision = 1): Promise<SyncEntity> => ({ kind: 'event', id, value, revision, hash: await entityHash(value) });
const a = await make('a', { total: 7 }), b = await make('b', { total: 11 });
async function run(name: string, action: () => Promise<void>) {
  try { await action(); result.checks.push({ name, passed: true }); }
  catch (error) { result.checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  render();
}
render();
await run('staged baseline promotes entities and state atomically in real IndexedDB', async () => {
  state = await cache.write(state, { state: { ...state, phase: 'full_loading' }, stages: [a, b].map(entity => ({ type: 'entity', run: 'one', entry: entity, entity })) });
  check((await cache.entities(namespace, cut.dataset_epoch, [a, b])).every(row => !row), 'staged entity leaked into active cache');
  state = await cache.write(state, { state: { ...state, activeLease: lease, phase: 'full_ready', appliedCommitSeq: 1 }, finalizeBaseline: 'one', clearStages: ['one'] });
  check((await cache.entities(namespace, cut.dataset_epoch, [a, b])).every(Boolean), 'final entities missing');
  check((await cache.stages(namespace, 'one')).length === 0, 'promoted stages retained');
});
await run('closing and reopening preserves complete entities and checkpoint', async () => {
  cache.close(); cache = new IndexedDbCloudCache(indexedDB, name);
  state = (await cache.state(namespace))!;
  check(state.appliedCommitSeq === 1 && state.phase === 'full_ready', 'checkpoint missing on reopen');
  check((await cache.entities(namespace, cut.dataset_epoch, [a]))[0]?.hash === a.hash, 'entity missing on reopen');
});
await run('hash reuse updates revision and prunes missing entities without downloading unchanged bodies', async () => {
  const next = { ...lease, lease_id: 'two', cut: { ...cut, commit_seq: 2 }, total_entities: 1, expected_entities: [{ kind: 'event' as const, count: 1 }] };
  state = await cache.write(state, { state, stages: [{ type: 'entity', run: 'two', entry: { kind: a.kind, id: a.id, hash: a.hash, revision: 2 } }] });
  state = await cache.write(state, { state: { ...state, activeLease: next, appliedCommitSeq: 2 }, finalizeBaseline: 'two', clearStages: ['two'] });
  const rows = await cache.entities(namespace, cut.dataset_epoch, [a, b]);
  check(rows[0]?.revision === 2 && rows[0]?.hash === a.hash && !rows[1], 'reuse/pruning did not match manifest');
});
await run('incomplete finalization rolls back entities and cursor together', async () => {
  const previous = state;
  state = await cache.write(state, { state, stages: [{ type: 'entity', run: 'bad', entry: { kind: 'event', id: 'missing', revision: 1, hash: a.hash } }] });
  const checkpoint = state;
  let failed = false;
  try { await cache.write(state, { state: { ...state, appliedCommitSeq: 99, activeLease: { ...lease, lease_id: 'bad' } }, finalizeBaseline: 'bad' }); } catch { failed = true; }
  check(failed, 'incomplete transaction did not fail');
  state = (await cache.state(namespace))!;
  check(state.version === checkpoint.version && state.appliedCommitSeq === previous.appliedCommitSeq, 'failed cursor was committed');
  check((await cache.entities(namespace, cut.dataset_epoch, [a]))[0]?.revision === 2, 'existing entity was rolled back incorrectly');
});
await run('batched promotion crosses page boundaries and exact run prefixes preserve neighbouring stages', async () => {
  const run = 'quoted,"run]😀', neighbour = run + 'x';
  const rows = Array.from({ length: 600 }, (_, i) => ({ ...a, id: 'batch-' + String(i).padStart(4, '0') }));
  const next = { ...lease, lease_id: run, cut: { ...cut, commit_seq: 3 }, total_entities: rows.length, expected_entities: [{ kind: 'event' as const, count: rows.length }] };
  state = await cache.write(state, { state, stages: [...rows.map(entity => ({ type: 'entity' as const, run, entry: entity, entity })), { type: 'entity', run: neighbour, entry: b, entity: b }] });
  state = await cache.write(state, { state: { ...state, activeLease: next, appliedCommitSeq: 3 }, finalizeBaseline: run, clearStages: [run] });
  const stored = await cache.entities(namespace, cut.dataset_epoch, rows);
  check(stored.length === 600 && stored.every(row => row?.hash === a.hash), 'batch boundary lost history');
  check((await cache.stages(namespace, run)).length === 0, 'exact run was not cleared');
  check((await cache.stages(namespace, neighbour)).length === 1, 'neighbouring run was cleared');
  check(!(await cache.entities(namespace, cut.dataset_epoch, [a]))[0], 'prior epoch entities were not pruned');
});
await run('concurrent tabs use compare-and-swap and stale query writes cannot resurrect removed history', async () => {
  const other = new IndexedDbCloudCache(indexedDB, name);
  const prior = (await other.state(namespace))!; state = await cache.write(state, { state });
  let conflict = false;
  try { await other.write(prior, { state: prior }); } catch (error) { conflict = error instanceof CacheConflict; }
  check(conflict, 'stale tab advanced checkpoint');
  const response = { data: { old: true }, meta: { source: 'cloud', updatedAt: null, timezone: 'UTC', warnings: [] } };
  const query = { key: 'page', cut: state.activeLease!.cut, response, cachedAt: new Date().toISOString() };
  await other.putQuery(namespace, query); check(!!await cache.query(namespace, 'page'), 'valid query was not cached');
  state = await cache.write(state, { state: emptyState(namespace), resetUser: true });
  await other.putQuery(namespace, query); check(!await cache.query(namespace, 'page'), 'deleted history was resurrected');
  other.close();
});
await run('user reset removes every device scope while preserving another user', async () => {
  const scope = namespaceOf({ origin: location.origin, userId: 'test-user', deviceIds: ['one'] }), stranger = namespaceOf({ origin: location.origin, userId: 'other-user', deviceIds: [] });
  for (const own of [scope, stranger]) {
    const initial = emptyState(own), next: CacheState = { ...initial, activeLease: lease };
    await cache.write(initial, { state: next, entities: [a] });
  }
  state = await cache.write(state, { state: emptyState(namespace), resetUser: true });
  check(!await cache.state(scope), 'another device scope survived reset');
  check(!(await cache.entities(scope, cut.dataset_epoch, [a]))[0], 'another device entity survived reset');
  check(!!await cache.state(stranger) && !!(await cache.entities(stranger, cut.dataset_epoch, [a]))[0], 'another user was removed');
});
await run('account observations persist across reopen and device scopes without any usage lease', async () => {
  const scope = namespaceOf({ origin: location.origin, userId: 'test-user', deviceIds: ['windows'] });
  const first = await cache.account(namespace, 'account/cloud');
  const query = { key: 'account/cloud', response: { data: ['old'], meta: { source: 'account', updatedAt: null, timezone: 'UTC', warnings: [] } }, cachedAt: new Date().toISOString() };
  check(await cache.putAccount(namespace, first.generation, query), 'initial account write failed');
  await cache.refreshAccounts(scope);
  const refreshed = await cache.account(scope, query.key);
  check(refreshed.query?.response.data instanceof Array && refreshed.query.generation !== refreshed.generation, 'refresh lost prior offline observation or stale marker');
  check(!await cache.putAccount(namespace, first.generation, query), 'stale refresh response overwrote new generation');
  check(await cache.putAccount(scope, refreshed.generation, { ...query, response: { ...query.response, data: ['latest'] } }), 'refreshed account write failed');
  cache.close(); cache = new IndexedDbCloudCache(indexedDB, name);
  const persisted = await cache.account(namespace, query.key);
  check((persisted.query?.response.data as string[])?.[0] === 'latest' && persisted.query?.generation === persisted.generation, 'latest shared account did not persist');
});
await run('account generation rejects deletion races across scopes and preserves other users', async () => {
  const scope = namespaceOf({ origin: location.origin, userId: 'test-user', deviceIds: ['windows'] });
  const stranger = namespaceOf({ origin: location.origin, userId: 'other-user', deviceIds: [] });
  const own = await cache.account(scope, 'account/cloud'), other = await cache.account(stranger, 'account/cloud');
  const query = { key: 'account/cloud', response: { data: ['other'], meta: { source: 'account', updatedAt: null, timezone: 'UTC', warnings: [] } }, cachedAt: new Date().toISOString() };
  await cache.putAccount(stranger, other.generation, query);
  state = await cache.write(state, { state: emptyState(namespace), resetUser: true });
  const recreated = await cache.account(scope, query.key);
  check(!recreated.query && recreated.generation !== own.generation, 'deleted account generation was reused');
  check(!await cache.putAccount(scope, own.generation, query), 'late account response repopulated deleted state');
  check((await cache.account(stranger, query.key)).query?.response.data instanceof Array, 'other user account was deleted');
});
cache.close(); result.complete = true; render();
await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
