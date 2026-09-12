import { stableJson, type SyncCut, type SyncEntity, type EntityKind } from '../../contracts/sync.js';
import type { ApiResponse } from '../../contracts/responses.js';
import { type ReadLease } from '../../contracts/read-lease.js';

export type EntityRef = { kind: EntityKind; id: string };

export type ManifestEntry = Omit<SyncEntity, 'value'>;

export type CacheIdentity = { origin: string; userId: string; deviceIds: string[] };

export const namespaceOf = (identity: CacheIdentity) => stableJson([identity.origin, identity.userId, [...new Set(identity.deviceIds)].sort()]);

export const accountNamespace = (namespace: string) => stableJson([...JSON.parse(namespace).slice(0, 2), 'account-observation']);

export const entityKey = (ref: EntityRef) => stableJson([ref.kind, ref.id]);

export const sameCut = (a: SyncCut | null | undefined, b: SyncCut | null | undefined) => !!a && !!b && stableJson(a) === stableJson(b);

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

export type AccountState = {
    namespace: string;
    accountGeneration: string;
};

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

export const entityId = (namespace: string, epoch: string, ref: EntityRef) => stableJson([namespace, epoch, ref.kind, ref.id]);

export const stageRun = (namespace: string, run: string) => stableJson([namespace, run]);

export const stagePrimary = (namespace: string, row: StagedRow) => stableJson([namespace, row.run, stageId(row)]);

export const clone = <T>(value: T): T => structuredClone(value);

export const sameUser = (a: string, b: string) => stableJson(JSON.parse(a).slice(0, 2)) === stableJson(JSON.parse(b).slice(0, 2));

export type StoredEntity = {
    key: string;
    namespace: string;
    epoch: string;
    entity: SyncEntity;
};

export type StoredStage = {
    key: string;
    namespace: string;
    runKey: string;
    row: StagedRow;
};

export type StoredQuery = {
    key: string;
    namespace: string;
    query: CachedQuery;
};

export type StoredAccountQuery = {
    key: string;
    namespace: string;
    account: CachedAccountQuery;
};

export const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
    tx.onerror = () => reject(tx.error);
});

// Object keys are JSON tuples. An exact, terminated tuple prefix cannot match a
// neighbouring user or run, even when identifiers contain quotes or commas.
export const tupleRange = (parts: string[], after?: string) => {
    const prefix = stableJson(parts).slice(0, -1) + ',';
    return IDBKeyRange.bound(after ?? prefix, prefix + '\uffff', after !== undefined, true);
};

export async function forEachBatch<T extends {
    key: string;
}>(store: IDBObjectStore, parts: string[], visit: (rows: T[]) => Promise<void>) {
    let after: string | undefined;
    for (;;) {
        const rows = await request(store.getAll(tupleRange(parts, after), 256)) as T[];
        if (!rows.length)
            return;
        await visit(rows);
        after = rows[rows.length - 1].key;
        if (rows.length < 256)
            return;
    }
}

export const cursorEach = (source: IDBObjectStore | IDBIndex, range: IDBKeyRange | undefined, visit: (cursor: IDBCursorWithValue) => void | Promise<void>) => new Promise<void>((resolve, reject) => {
    const req = source.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor)
            return resolve();
        try {
            Promise.resolve(visit(cursor)).then(() => { try {
                cursor.continue();
            }
            catch (error) {
                reject(error);
            } }, reject);
        }
        catch (error) {
            reject(error);
        }
    };
});

export type { ReadLease } from '../../contracts/read-lease.js';
