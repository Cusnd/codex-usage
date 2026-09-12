import { stableJson, type SyncEntity } from '../../contracts/sync.js';
import { type CloudCache, type CacheState, type AccountState, type StagedRow, type CachedQuery, type CachedAccountQuery, clone, type EntityRef, entityId, type ManifestEntry, stagePrimary, type StagedEntity, sameCut, type AccountCacheRead, accountNamespace, type CacheWrite, CacheConflict, sameUser } from './cache-model.js';

// The memory implementation follows the same atomic operation boundary and is injectable in protocol tests.
export class MemoryCloudCache implements CloudCache {
  private states = new Map<string, CacheState>();
  private accountStates = new Map<string, AccountState>();
  private records = new Map<string, SyncEntity>();
  private pending = new Map<string, { namespace: string; row: StagedRow }>();
  private queries = new Map<string, { namespace: string; query?: CachedQuery; account?: CachedAccountQuery }>();
  async state(namespace: string) { return clone(this.states.get(namespace) ?? null); }
  async entities(namespace: string, epoch: string, refs: EntityRef[]) { return refs.map(ref => clone(this.records.get(entityId(namespace, epoch, ref)))); }
  async stages(namespace: string, run: string) { return [...this.pending.values()].filter(x => x.namespace === namespace && x.row.run === run).map(x => clone(x.row)); }
  async stagedEntities(namespace: string, run: string, refs: ManifestEntry[]) { return refs.map(entry => clone(this.pending.get(stagePrimary(namespace, { type: 'entity', run, entry }))?.row as StagedEntity | undefined)); }
  async query(namespace: string, key: string) { return clone(this.queries.get(stableJson([namespace, key]))?.query); }
  async putQuery(namespace: string, query: CachedQuery) {
    if (sameCut(this.states.get(namespace)?.activeLease?.cut, query.cut)) this.queries.set(stableJson([namespace, query.key]), { namespace, query: clone(query) });
  }
  async account(namespace: string, key: string): Promise<AccountCacheRead> {
    const own = accountNamespace(namespace);
    let state = this.accountStates.get(own);
    if (!state) { state = { namespace: own, accountGeneration: crypto.randomUUID() }; this.accountStates.set(own, state); }
    return { generation: state.accountGeneration, query: clone(this.queries.get(stableJson([own, key]))?.account) };
  }
  async refreshAccounts(namespace: string) {
    const own = accountNamespace(namespace); this.accountStates.set(own, { namespace: own, accountGeneration: crypto.randomUUID() });
  }
  async putAccount(namespace: string, generation: string, query: Omit<CachedAccountQuery, 'generation'>) {
    const own = accountNamespace(namespace);
    if (this.accountStates.get(own)?.accountGeneration !== generation) return false;
    this.queries.set(stableJson([own, query.key]), { namespace: own, account: clone({ ...query, generation }) }); return true;
  }
  async write(expected: CacheState, change: CacheWrite) {
    if ((this.states.get(expected.namespace)?.version ?? 0) !== expected.version) throw new CacheConflict();
    const namespace = expected.namespace, next = clone({ ...change.state, namespace, version: expected.version + 1 });
    const records = new Map(this.records), pending = new Map(this.pending), queries = new Map(this.queries);
    const states = new Map(this.states), accountStates = new Map(this.accountStates);
    const clearEntities = () => { for (const key of records.keys()) if (JSON.parse(key)[0] === namespace) records.delete(key); };
    if (change.reset) {
      clearEntities();
      for (const [key, value] of pending) if (value.namespace === namespace) pending.delete(key);
    }
    if (change.clearQueries || change.reset) for (const [key, value] of queries) if (value.namespace === namespace) queries.delete(key);
    if (change.resetUser) {
      for (const key of records.keys()) if (sameUser(JSON.parse(key)[0], namespace)) records.delete(key);
      for (const [key, value] of pending) if (sameUser(value.namespace, namespace)) pending.delete(key);
      for (const [key, value] of queries) if (sameUser(value.namespace, namespace)) queries.delete(key);
      for (const key of states.keys()) if (sameUser(key, namespace)) states.delete(key);
      for (const key of accountStates.keys()) if (sameUser(key, namespace)) accountStates.delete(key);
    }
    for (const row of change.stages ?? []) pending.set(stagePrimary(namespace, row), { namespace, row: clone(row) });
    if (change.finalizeBaseline) {
      const epoch = next.activeLease!.cut.dataset_epoch;
      const rows = [...pending.values()].filter(x => x.namespace === namespace && x.row.run === change.finalizeBaseline && x.row.type === 'entity').map(x => x.row as StagedEntity);
      const keep = new Set(rows.map(row => entityId(namespace, epoch, row.entry)));
      for (const row of rows) {
        const key = entityId(namespace, epoch, row.entry), old = records.get(key), value = row.entity ?? (old ? { ...old, revision: row.entry.revision } : undefined);
        if (!value || value.hash !== row.entry.hash || value.revision !== row.entry.revision) throw new Error('Incomplete baseline entity.');
        if (!old || old.hash !== value.hash || old.revision !== value.revision) records.set(key, clone(value));
      }
      for (const key of records.keys()) if (JSON.parse(key)[0] === namespace && !keep.has(key)) records.delete(key);
    }
    const epoch = next.deltaLease?.cut.dataset_epoch ?? next.activeLease?.cut.dataset_epoch;
    for (const entity of change.entities ?? []) { if (!epoch) throw new Error('Missing cache epoch.'); records.set(entityId(namespace, epoch, entity), clone(entity)); }
    for (const ref of change.deleted ?? []) { if (epoch) records.delete(entityId(namespace, epoch, ref)); }
    for (const run of change.clearStages ?? []) for (const [key, value] of pending) if (value.namespace === namespace && value.row.run === run) pending.delete(key);
    this.records = records; this.pending = pending; this.queries = queries; states.set(namespace, next); this.states = states; this.accountStates = accountStates;
    return clone(next);
  }
  close() {}
}
