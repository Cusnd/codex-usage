import { stableJson } from '../../contracts/sync.js';
import { SYNC_VERSION } from "../../contracts/sync-version.js";
import { type CloudCache, request, type CacheState, type EntityRef, entityId, type StoredEntity, stageRun, type StoredStage, type ManifestEntry, stagePrimary, type StagedEntity, type StoredQuery, type CachedQuery, done, sameCut, type AccountCacheRead, accountNamespace, type AccountState, type StoredAccountQuery, type CachedAccountQuery, type CacheWrite, CacheConflict, cursorEach, sameUser, forEachBatch, tupleRange } from './cache-model.js';

export class IndexedDbCloudCache implements CloudCache {
  private connection: Promise<IDBDatabase>;
  constructor(factory: IDBFactory = indexedDB, name = `codex-usage-cloud-${SYNC_VERSION}`) {
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
