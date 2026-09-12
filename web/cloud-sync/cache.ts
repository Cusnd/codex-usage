import { stableJson, type SyncCut, type SyncEntity, type EntityKind } from '../../shared/sync-v3';
import type { ApiResponse, Settings } from '../../shared/contracts';

export type EntityRef = { kind: EntityKind; id: string };
export type ManifestEntry = Omit<SyncEntity, 'value'>;
export type CacheIdentity = { origin: string; userId: string; deviceIds: string[] };
export const namespaceOf = (identity: CacheIdentity) => stableJson([identity.origin, identity.userId, [...new Set(identity.deviceIds)].sort()]);
const accountNamespace = (namespace: string) => stableJson([...JSON.parse(namespace).slice(0, 2), 'account-observation']);
export const entityKey = (ref: EntityRef) => stableJson([ref.kind, ref.id]);
export const sameCut = (a: SyncCut | null | undefined, b: SyncCut | null | undefined) => !!a && !!b && stableJson(a) === stableJson(b);
export type ReadLease = {
  lease_id: string; cut: SyncCut; scope: 'recent' | 'full'; expected_entities: { kind: EntityKind; count: number }[];
  total_entities: number; expires_at: string; coverage?: unknown; settings?: Settings;
  selection?: { from_at: string | null; include_active: boolean };
};
export type BaselineProgress = {
  lease: ReadLease; cursor: string | null; started: boolean; counts: Partial<Record<EntityKind, number>>;
  last_key: string | null; page: { entries: ManifestEntry[]; next_cursor: string | null } | null;
};
export type CacheState = {
  namespace: string; version: number; phase: 'empty' | 'recent_loading' | 'recent_ready' | 'full_loading' | 'full_ready' | 'delta_loading';
  activeLease: ReadLease | null; coverage: { scope: 'recent' | 'full'; complete: true; cut: SyncCut; entities: number; sources: unknown } | null;
  baseline: BaselineProgress | null; deltaLease: ReadLease | null;
  receivedCommitSeq: number; appliedCommitSeq: number; lastSyncAt: string | null; viewAt: string | null; error: string | null;
};
export const emptyState = (namespace: string): CacheState => ({ namespace, version: 0, phase: 'empty', activeLease: null, coverage: null,
  baseline: null, deltaLease: null, receivedCommitSeq: 0, appliedCommitSeq: 0, lastSyncAt: null, viewAt: null, error: null });
export type StagedEntity = { type: 'entity'; run: string; entry: ManifestEntry; entity?: SyncEntity };
export type StagedCommit = { type: 'commit'; run: string; seq: number; chunk: number; chunks: number; total: number; entities: SyncEntity[]; deleted: EntityRef[] };
export type StagedRow = StagedEntity | StagedCommit;
export type CachedQuery = { key: string; cut: SyncCut; response: ApiResponse<unknown>; cachedAt: string };
export type CachedAccountQuery = { key: string; generation: string; response: ApiResponse<unknown>; cachedAt: string };
type AccountState = { namespace: string; accountGeneration: string };
export type AccountCacheRead = { generation: string; query?: CachedAccountQuery };
export type CacheWrite = {
  state: CacheState; stages?: StagedRow[]; entities?: SyncEntity[]; deleted?: EntityRef[];
  clearQueries?: boolean; clearStages?: string[]; reset?: boolean; resetUser?: boolean; finalizeBaseline?: string;
};
export interface CloudCache {
  state(namespace: string): Promise<CacheState | null>;
  entities(namespace: string, epoch: string, refs: EntityRef[]): Promise<(SyncEntity | undefined)[]>;
  stages(namespace: string, run: string): Promise<StagedRow[]>;
  stagedEntities(namespace: string, run: string, refs: ManifestEntry[]): Promise<(StagedEntity | undefined)[]>;
  query(namespace: string, key: string): Promise<CachedQuery | undefined>;
  putQuery(namespace: string, query: CachedQuery): Promise<void>;
  account(namespace: string, key: string): Promise<AccountCacheRead>;
  refreshAccounts(namespace: string): Promise<void>;
  putAccount(namespace: string, generation: string, query: Omit<CachedAccountQuery, 'generation'>): Promise<boolean>;
  write(expected: CacheState, change: CacheWrite): Promise<CacheState>;
  close(): void;
}
export class CacheConflict extends Error { constructor() { super('Another browser tab advanced this cache. Resume from its saved checkpoint.'); } }
const stageId = (row: StagedRow) => row.type === 'entity' ? entityKey(row.entry) : stableJson(['commit', row.seq, row.chunk]);
const entityId = (namespace: string, epoch: string, ref: EntityRef) => stableJson([namespace, epoch, ref.kind, ref.id]);
const stageRun = (namespace: string, run: string) => stableJson([namespace, run]);
const stagePrimary = (namespace: string, row: StagedRow) => stableJson([namespace, row.run, stageId(row)]);
const clone = <T>(value: T): T => structuredClone(value);
const sameUser = (a: string, b: string) => stableJson(JSON.parse(a).slice(0, 2)) === stableJson(JSON.parse(b).slice(0, 2));

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

type StoredEntity = { key: string; namespace: string; epoch: string; entity: SyncEntity };
type StoredStage = { key: string; namespace: string; runKey: string; row: StagedRow };
type StoredQuery = { key: string; namespace: string; query: CachedQuery };
type StoredAccountQuery = { key: string; namespace: string; account: CachedAccountQuery };
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.')); tx.onerror = () => reject(tx.error);
});
// Object keys are JSON tuples. An exact, terminated tuple prefix cannot match a
// neighbouring user or run, even when identifiers contain quotes or commas.
const tupleRange = (parts: string[], after?: string) => {
  const prefix = stableJson(parts).slice(0, -1) + ',';
  return IDBKeyRange.bound(after ?? prefix, prefix + '\uffff', after !== undefined, true);
};
async function forEachBatch<T extends { key: string }>(store: IDBObjectStore, parts: string[], visit: (rows: T[]) => Promise<void>) {
  let after: string | undefined;
  for (;;) {
    const rows = await request(store.getAll(tupleRange(parts, after), 256)) as T[];
    if (!rows.length) return;
    await visit(rows); after = rows[rows.length - 1].key;
    if (rows.length < 256) return;
  }
}
const cursorEach = (source: IDBObjectStore | IDBIndex, range: IDBKeyRange | undefined, visit: (cursor: IDBCursorWithValue) => void | Promise<void>) => new Promise<void>((resolve, reject) => {
  const req = source.openCursor(range);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return resolve();
    try { Promise.resolve(visit(cursor)).then(() => { try { cursor.continue(); } catch (error) { reject(error); } }, reject); }
    catch (error) { reject(error); }
  };
});

export class IndexedDbCloudCache implements CloudCache {
  private connection: Promise<IDBDatabase>;
  constructor(factory: IDBFactory = indexedDB, name = 'codex-usage-cloud-current') {
    this.connection = new Promise((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['entities', 'query_results', 'staging']) {
          const store = db.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('namespace', 'namespace');
          if (name === 'staging') store.createIndex('run', 'runKey');
        }
        db.createObjectStore('sync_state', { keyPath: 'namespace' });
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Close older Codex Usage tabs to update the offline cache.'));
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    });
  }
  async state(namespace: string) {
    const db = await this.connection, tx = db.transaction('sync_state');
    return (await request(tx.objectStore('sync_state').get(namespace)) as CacheState | undefined) ?? null;
  }
  async entities(namespace: string, epoch: string, refs: EntityRef[]) {
    const db = await this.connection, tx = db.transaction('entities'), store = tx.objectStore('entities');
    return Promise.all(refs.map(async ref => (await request(store.get(entityId(namespace, epoch, ref))) as StoredEntity | undefined)?.entity));
  }
  async stages(namespace: string, run: string) {
    const db = await this.connection, tx = db.transaction('staging');
    return (await request(tx.objectStore('staging').index('run').getAll(IDBKeyRange.only(stageRun(namespace, run)))) as StoredStage[]).map(x => x.row);
  }
  async stagedEntities(namespace: string, run: string, refs: ManifestEntry[]) {
    const db = await this.connection, tx = db.transaction('staging'), store = tx.objectStore('staging');
    return Promise.all(refs.map(async entry => (await request(store.get(stagePrimary(namespace, { type: 'entity', run, entry }))) as StoredStage | undefined)?.row as StagedEntity | undefined));
  }
  async query(namespace: string, key: string) {
    const db = await this.connection, tx = db.transaction('query_results');
    return (await request(tx.objectStore('query_results').get(stableJson([namespace, key]))) as StoredQuery | undefined)?.query;
  }
  async putQuery(namespace: string, query: CachedQuery) {
    const db = await this.connection, tx = db.transaction(['query_results', 'sync_state'], 'readwrite'), complete = done(tx);
    // A completed deletion must not be undone by an older in-flight page response.
    const state = await request(tx.objectStore('sync_state').get(namespace)) as CacheState | undefined;
    if (state?.activeLease && sameCut(state.activeLease.cut, query.cut)) tx.objectStore('query_results').put({ key: stableJson([namespace, query.key]), namespace, query });
    await complete;
  }
  async account(namespace: string, key: string): Promise<AccountCacheRead> {
    const own = accountNamespace(namespace), db = await this.connection;
    const tx = db.transaction(['query_results', 'sync_state'], 'readwrite'), complete = done(tx); complete.catch(() => {});
    const states = tx.objectStore('sync_state');
    let state = await request(states.get(own)) as AccountState | undefined;
    if (!state) { state = { namespace: own, accountGeneration: crypto.randomUUID() }; states.put(state); }
    const row = await request(tx.objectStore('query_results').get(stableJson([own, key]))) as StoredAccountQuery | undefined;
    await complete; return { generation: state.accountGeneration, query: row?.account };
  }
  async refreshAccounts(namespace: string) {
    const own = accountNamespace(namespace), db = await this.connection, tx = db.transaction('sync_state', 'readwrite'), complete = done(tx);
    tx.objectStore('sync_state').put({ namespace: own, accountGeneration: crypto.randomUUID() } satisfies AccountState); await complete;
  }
  async putAccount(namespace: string, generation: string, query: Omit<CachedAccountQuery, 'generation'>) {
    const own = accountNamespace(namespace), db = await this.connection;
    const tx = db.transaction(['query_results', 'sync_state'], 'readwrite'), complete = done(tx); complete.catch(() => {});
    const state = await request(tx.objectStore('sync_state').get(own)) as AccountState | undefined;
    const current = state?.accountGeneration === generation;
    // Refresh and user deletion use this same transaction scope, so late responses cannot repopulate an older generation.
    if (current) tx.objectStore('query_results').put({ key: stableJson([own, query.key]), namespace: own, account: { ...query, generation } } satisfies StoredAccountQuery);
    await complete; return current;
  }
  async write(expected: CacheState, change: CacheWrite) {
    const db = await this.connection, tx = db.transaction(['entities', 'query_results', 'sync_state', 'staging'], 'readwrite'), complete = done(tx);
    // Always observe rejection, including when a request fails before the final await.
    complete.catch(() => {});
    const stateStore = tx.objectStore('sync_state'), entities = tx.objectStore('entities'), stages = tx.objectStore('staging'), queries = tx.objectStore('query_results');
    const namespace = expected.namespace, next = { ...change.state, namespace, version: expected.version + 1 };
    try {
      const current = await request(stateStore.get(namespace)) as CacheState | undefined;
      if ((current?.version ?? 0) !== expected.version) throw new CacheConflict();
      const removeNamespace = (store: IDBObjectStore) => cursorEach(store.index('namespace'), IDBKeyRange.only(namespace), cursor => { cursor.delete(); });
      if (change.reset) { await removeNamespace(entities); await removeNamespace(stages); }
      if (change.clearQueries || change.reset) await removeNamespace(queries);
      if (change.resetUser) {
        const namespaces: string[] = [];
        await cursorEach(stateStore, undefined, cursor => { if (sameUser((cursor.value as CacheState).namespace, namespace)) { namespaces.push((cursor.value as CacheState).namespace); cursor.delete(); } });
        for (const own of namespaces) for (const store of [entities, stages, queries]) await cursorEach(store.index('namespace'), IDBKeyRange.only(own), cursor => { cursor.delete(); });
      }
      for (const row of change.stages ?? []) stages.put({ key: stagePrimary(namespace, row), namespace, runKey: stageRun(namespace, row.run), row });
      if (change.finalizeBaseline) {
        const run = change.finalizeBaseline, epoch = next.activeLease!.cut.dataset_epoch;
        const keep = new Set<IDBValidKey>();
        await forEachBatch<StoredStage>(stages, [namespace, run], async batch => {
          // Queue reused-body reads together. Downloaded bodies need no prior read.
          const rows = batch.map(({ row }) => {
            if (row.type !== 'entity') throw new Error('Unexpected baseline staging row.');
            return row;
          });
          const keys = rows.map(row => entityId(namespace, epoch, row.entry));
          const prior = await Promise.all(rows.map((row, i) => row.entity ? undefined : request(entities.get(keys[i])) as Promise<StoredEntity | undefined>));
          rows.forEach((row, i) => {
            const key = keys[i], old = prior[i], value = row.entity ?? (old ? { ...old.entity, revision: row.entry.revision } : undefined);
            if (!value || value.hash !== row.entry.hash || value.revision !== row.entry.revision) throw new Error('Incomplete baseline entity.');
            keep.add(key);
            if (!old || old.entity.hash !== value.hash || old.entity.revision !== value.revision) entities.put({ key, namespace, epoch, entity: value });
          });
        });
        // Read keys only: pruning must not deserialize the complete history again.
        const keys = await request(entities.index('namespace').getAllKeys(IDBKeyRange.only(namespace)));
        for (const key of keys) if (!keep.has(key)) entities.delete(key);
      }
      const epoch = next.deltaLease?.cut.dataset_epoch ?? next.activeLease?.cut.dataset_epoch;
      for (const entity of change.entities ?? []) { if (!epoch) throw new Error('Missing cache epoch.'); entities.put({ key: entityId(namespace, epoch, entity), namespace, epoch, entity }); }
      for (const ref of change.deleted ?? []) if (epoch) entities.delete(entityId(namespace, epoch, ref));
      for (const run of change.clearStages ?? []) stages.delete(tupleRange([namespace, run]));
      stateStore.put(next);
      await complete;
      return next;
    } catch (error) { try { tx.abort(); } catch {} await complete.catch(() => {}); throw error; }
  }
  close() { void this.connection.then(db => db.close(), () => {}); }
}
