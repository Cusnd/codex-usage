import { stableJson, type ChangesPage, type SnapshotManifestPage, type SyncCut, type SyncEntity, type EntityKind } from '../../shared/sync-v3';
import { SYNC_HEADER, SYNC_VERSION, assertCloudVersion, VERSION_MISMATCH } from '../../shared/cloud-version';
import { CacheConflict, emptyState, entityKey, namespaceOf, sameCut, type CacheIdentity, type CacheState, type CacheWrite, type CloudCache,
  type ReadLease, type ManifestEntry, type StagedCommit, type StagedEntity } from './cache';

export type SyncStatus = { user_id: string; cut: SyncCut; mode: string; coverage?: unknown; devices?: unknown[] };
type EntityPage = { lease_id: string; cut: SyncCut; entities: SyncEntity[]; expires_at?: string };
type Commit = ChangesPage['commits'][number] & { entity_count?: number; chunk_index?: number; chunk_count?: number; complete?: boolean };
export type ChangeResponse = Omit<ChangesPage, 'commits'> & { commits: Commit[] };
export interface SyncTransport {
  status(signal?: AbortSignal): Promise<SyncStatus>;
  read(scope: 'recent' | 'full', deviceIds: string[], fromLease?: string, signal?: AbortSignal): Promise<ReadLease>;
  renew(lease: string, signal?: AbortSignal): Promise<{ expires_at: string; cut?: SyncCut }>;
  manifest(lease: string, cursor: string | null, signal?: AbortSignal): Promise<SnapshotManifestPage>;
  entities(lease: string, entries: ManifestEntry[], signal?: AbortSignal): Promise<EntityPage>;
  changes(lease: ReadLease, after: number, signal?: AbortSignal): Promise<ChangeResponse>;
}
export class SyncError extends Error { constructor(message: string, readonly code = 'SYNC_PROTOCOL', readonly status?: number) { super(message); } }
export async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const cloud = /^\/api\/v[123]\//.test(url);
  if (cloud) headers.set(SYNC_HEADER, SYNC_VERSION);
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers });
  try { if (cloud) assertCloudVersion(response); }
  catch(error) { if(typeof window!=='undefined')window.dispatchEvent(new Event('cloud-version-mismatch'));throw error; }
  const body = await response.json();
  if(body.error?.code===VERSION_MISMATCH&&typeof window!=='undefined')window.dispatchEvent(new Event('cloud-version-mismatch'));
  if (!response.ok) throw new SyncError(body.error?.message || 'Cloud request failed.', body.error?.code || 'HTTP_ERROR', response.status);
  return body as T;
}
export class HttpSyncTransport implements SyncTransport {
  constructor(private request: typeof jsonRequest = jsonRequest) {}
  status(signal?: AbortSignal) { return this.request<SyncStatus>('/api/v3/sync/status', { signal }); }
  private post<T>(route: string, body: unknown, signal?: AbortSignal) { return this.request<T>(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); }
  read(scope: 'recent' | 'full', deviceIds: string[], fromLease?: string, signal?: AbortSignal) {
    return this.post<ReadLease>('/api/v3/sync/read', { scope, device_ids: deviceIds, ...(fromLease ? { from_lease_id: fromLease } : {}) }, signal);
  }
  renew(lease: string, signal?: AbortSignal) { return this.post<{ expires_at: string; cut?: SyncCut }>(`/api/v3/sync/read/${encodeURIComponent(lease)}/renew`, {}, signal); }
  manifest(lease: string, cursor: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ limit: '200' }); if (cursor !== null) params.set('cursor', cursor);
    return this.request<SnapshotManifestPage>(`/api/v3/sync/read/${encodeURIComponent(lease)}/manifest?${params}`, { signal });
  }
  entities(lease: string, entries: ManifestEntry[], signal?: AbortSignal) { return this.post<EntityPage>(`/api/v3/sync/read/${encodeURIComponent(lease)}/entities`, { entities: entries }, signal); }
  changes(lease: ReadLease, after: number, signal?: AbortSignal) {
    const params = new URLSearchParams({ lease_id: lease.lease_id, dataset_epoch: lease.cut.dataset_epoch, after: String(after), limit: '20' });
    return this.request<ChangeResponse>('/api/v3/sync/changes?' + params, { signal });
  }
}

const kinds: EntityKind[] = ['account', 'device', 'event', 'project', 'settings', 'thread'];
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export function validCut(value: unknown): value is SyncCut {
  const cut = value as SyncCut;
  return !!cut && typeof cut.dataset_epoch === 'string' && !!cut.dataset_epoch &&
    [cut.commit_seq, cut.deletion_version, cut.organization_version, cut.config_version].every(integer);
}
function entryValid(entry: ManifestEntry) {
  return entry && kinds.includes(entry.kind) && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 2048 && integer(entry.revision) && /^[a-f0-9]{64}$/.test(entry.hash);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new SyncError(message); }
export async function entityHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function verifyEntities(entities: SyncEntity[]) {
  assert(Array.isArray(entities), 'Invalid entity response.');
  const seen = new Set<string>();
  for (const entity of entities) {
    assert(entryValid(entity) && Object.hasOwn(entity, 'value'), 'Invalid entity envelope.');
    const key = entityKey(entity); assert(!seen.has(key), 'Duplicate entity response.'); seen.add(key);
    assert(await entityHash(entity.value) === entity.hash, 'Entity content hash mismatch.');
  }
}
function verifyLease(lease: ReadLease, scope: 'recent' | 'full') {
  assert(lease && typeof lease.lease_id === 'string' && !!lease.lease_id && validCut(lease.cut) && lease.scope === scope &&
    integer(lease.total_entities) && Number.isFinite(Date.parse(lease.expires_at)) && Array.isArray(lease.expected_entities), 'Invalid snapshot lease.');
  const seen = new Set<EntityKind>();
  for (const row of lease.expected_entities) { assert(kinds.includes(row.kind) && integer(row.count) && !seen.has(row.kind), 'Invalid expected entity counts.'); seen.add(row.kind); }
  assert(lease.expected_entities.reduce((sum, row) => sum + row.count, 0) === lease.total_entities, 'Snapshot total does not match its per-kind counts.');
}
const compareRef = (a: ManifestEntry, b: ManifestEntry) => {
  // SQLite's BINARY order compares UTF-8 bytes, including non-BMP identifiers.
  const left = new TextEncoder().encode(a.kind === b.kind ? a.id : a.kind), right = new TextEncoder().encode(a.kind === b.kind ? b.id : b.kind);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
type Trigger = 'initial' | 'automatic' | 'manual';
type Options = { cache: CloudCache; identity: CacheIdentity; transport?: SyncTransport; now?: () => number; autoFull?: boolean };

export class CloudSyncController {
  readonly namespace: string;
  readonly identity: CacheIdentity;
  readonly cache: CloudCache;
  private transport: SyncTransport;
  private now: () => number;
  private autoFull: boolean;
  private current: CacheState;
  private initialized: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private pending: Trigger | null = null;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(options: Options) {
    this.identity = { ...options.identity, deviceIds: [...new Set(options.identity.deviceIds)].sort() };
    this.namespace = namespaceOf(this.identity); this.cache = options.cache; this.transport = options.transport ?? new HttpSyncTransport();
    this.now = options.now ?? Date.now; this.autoFull = options.autoFull !== false; this.current = emptyState(this.namespace);
  }
  state = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  initialize() {
    return this.initialized ??= this.cache.state(this.namespace).then(state => {
      this.current = state ?? emptyState(this.namespace);
      this.emit();
    });
  }
  private assertGeneration(generation: number) {
    this.abort.signal.throwIfAborted();
    if (generation !== this.generation) throw new SyncError('A cache reset invalidated this synchronization attempt.', 'CACHE_RESET');
  }
  private persist(transform: (state: CacheState) => CacheWrite, generation = this.generation) {
    const operation = this.writes.then(async () => {
      this.assertGeneration(generation);
      this.current = await this.cache.write(this.current, transform(this.current)); this.emit();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  private async request<T>(operation: () => Promise<T>, generation = this.generation) {
    this.assertGeneration(generation);
    const value = await operation();
    this.assertGeneration(generation);
    return value;
  }
  async settle() { await this.running?.catch(() => {}); }
  async invalidateForDeletion() {
    await this.initialize();
    this.generation++;
    await this.persist(state => ({ state: { ...emptyState(this.namespace), version: state.version }, resetUser: true }));
  }
  async trigger(reason: Trigger = 'manual'): Promise<void> {
    await this.initialize();
    if (this.running) { this.pending = this.pending === 'manual' || reason === 'manual' ? 'manual' : 'automatic'; return this.running; }
    this.running = (async () => {
      let next: Trigger | null = reason;
      do {
        this.pending = null;
        await this.cycle(next);
        next = this.pending;
      } while (next && !this.abort.signal.aborted);
    })().catch(async error => {
      if (error instanceof CacheConflict) { this.current = await this.cache.state(this.namespace) ?? emptyState(this.namespace); this.emit(); }
      else if (!this.abort.signal.aborted) await this.persist(state => ({ state: { ...state, error: error instanceof Error ? error.message : String(error) } })).catch(() => {});
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }
  private async cycle(reason: Trigger) {
    this.abort.signal.throwIfAborted();
    const head = await this.request(() => this.transport.status(this.abort.signal));
    assert(head.user_id === this.identity.userId && validCut(head.cut), 'Cloud cache identity or status is invalid.');
    const active = this.current.activeLease?.cut;
    if (head.mode === 'deleting' || active && head.cut.deletion_version > active.deletion_version) {
      await this.invalidateForDeletion();
      if (head.mode === 'deleting') throw new SyncError('Cloud history deletion is still in progress.', 'HISTORY_UPDATING', 409);
    }
    if (reason === 'automatic' && head.mode === 'ready' && this.current.phase === 'full_ready' && !this.current.baseline && !this.current.deltaLease &&
      sameCut(active, head.cut) && Date.parse(this.current.activeLease!.expires_at) > this.now() + 60_000) {
      // Status already proves this complete fixed cut is current, including a device scope.
      // Keep its display clock stable; only refresh the lease when it needs more time.
      await this.persist(state => ({ state: { ...state, lastSyncAt: new Date(this.now()).toISOString(), error: null } }));
      return;
    }
    try {
      if (this.current.baseline) await this.baseline();
      else if (!this.current.activeLease) { await this.beginBaseline('recent'); await this.baseline(); }
      else if (this.current.coverage?.scope === 'recent') {
        await this.beginBaseline('full', this.current.activeLease.lease_id); await this.baseline();
      } else if (reason === 'manual' || this.identity.deviceIds.length || head.cut.dataset_epoch !== this.current.activeLease.cut.dataset_epoch) {
        await this.beginBaseline('full'); await this.baseline();
      } else await this.delta();
      if (this.autoFull && this.current.coverage?.scope === 'recent') {
        await this.beginBaseline('full', this.current.activeLease!.lease_id); await this.baseline();
      }
    } catch (error) {
      if (error instanceof SyncError && error.code === 'BASELINE_REQUIRED') {
        const oldRun = this.current.baseline?.lease.lease_id ?? this.current.deltaLease?.lease_id;
        await this.persist(state => ({ state: { ...state, baseline: null, deltaLease: null }, clearStages: oldRun ? [oldRun] : [] }));
        // The old complete page view stays available during a new fixed-cut baseline.
        await this.beginBaseline(this.current.activeLease ? 'full' : 'recent'); await this.baseline();
        if (this.autoFull && this.current.coverage?.scope === 'recent') { await this.beginBaseline('full', this.current.activeLease!.lease_id); await this.baseline(); }
      } else throw error;
    }
  }
  private async beginBaseline(scope: 'recent' | 'full', fromLease?: string) {
    const generation = this.generation;
    const previousCut = fromLease ? this.current.activeLease?.cut : undefined;
    const lease = await this.request(() => this.transport.read(scope, this.identity.deviceIds, fromLease, this.abort.signal)); verifyLease(lease, scope);
    if (fromLease) assert(sameCut(previousCut, lease.cut), 'Recent and initial full snapshots must share the same cut.');
    await this.persist(state => ({ state: { ...state, phase: scope === 'recent' ? 'recent_loading' : 'full_loading', error: null, deltaLease: null,
      baseline: { lease, cursor: null, started: false, counts: {}, last_key: null, page: null } } }), generation);
  }
  private async freshLease(lease: ReadLease) {
    const generation = this.generation;
    if (Date.parse(lease.expires_at) > this.now() + 60_000) return lease;
    const renewed = await this.request(() => this.transport.renew(lease.lease_id, this.abort.signal));
    assert(Number.isFinite(Date.parse(renewed.expires_at)) && Date.parse(renewed.expires_at) > this.now(), 'Invalid lease renewal.');
    if (renewed.cut) assert(sameCut(renewed.cut, lease.cut), 'Lease renewal changed its cut.');
    const next = { ...lease, expires_at: renewed.expires_at };
    await this.persist(state => ({ state: { ...state,
      ...(state.baseline?.lease.lease_id === lease.lease_id ? { baseline: { ...state.baseline, lease: next } } : {}),
      ...(state.deltaLease?.lease_id === lease.lease_id ? { deltaLease: next } : {}),
      ...(state.activeLease?.lease_id === lease.lease_id ? { activeLease: next } : {}) } }), generation);
    return next;
  }
  async view(signal?: AbortSignal): Promise<ReadLease | null> {
    await this.initialize(); signal?.throwIfAborted();
    if (!this.current.activeLease) {
      const work = this.running ?? this.trigger('initial');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', cancelled); };
        const ready = () => { if (this.current.activeLease) { cleanup(); resolve(); } };
        const unsubscribe = this.subscribe(ready);
        const cancelled = () => { cleanup(); reject(signal?.reason); };
        signal?.addEventListener('abort', cancelled, { once: true });
        ready(); work.then(() => { if (!this.current.activeLease) { cleanup(); reject(new SyncError('No completed cloud view is available.')); } }, error => { cleanup(); reject(error); });
      });
    }
    assert(this.current.activeLease, 'No completed cloud view is available.');
    return this.current.activeLease;
  }
  async renewView(lease: ReadLease) { return this.freshLease(lease); }
  private async baseline() {
    const generation = this.generation, localAbort = new AbortController();
    const stop = () => localAbort.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', stop, { once: true });
    type ManifestResult = { ok: true; page: SnapshotManifestPage } | { ok: false; error: unknown };
    let ahead: { lease: string; cursor: string; promise: Promise<ManifestResult> } | null = null;
    const fetchManifest = (lease: string, cursor: string | null) => this.request(() => this.transport.manifest(lease, cursor, localAbort.signal), generation);
    const prefetch = (lease: string, cursor: string | null) => {
      // Observe rejection immediately; only consume or persist this page after the current page is durable.
      if (cursor !== null && !ahead) ahead = { lease, cursor, promise: fetchManifest(lease, cursor).then(page => ({ ok: true as const, page }), error => ({ ok: false as const, error })) };
    };
    const nextManifest = async (lease: string, cursor: string | null) => {
      if (ahead?.lease === lease && ahead.cursor === cursor) {
        const pending = ahead; ahead = null; const result = await pending.promise;
        this.assertGeneration(generation);
        if (!result.ok) throw result.error;
        return result.page;
      }
      return fetchManifest(lease, cursor);
    };
    const persist = (transform: (state: CacheState) => CacheWrite) => this.persist(transform, generation);
    try {
    for (;;) {
      this.assertGeneration(generation);
      const progress = this.current.baseline; assert(progress, 'Missing baseline checkpoint.');
      const lease = await this.freshLease(progress.lease);
      this.assertGeneration(generation);
      if (!progress.page) {
        const page = await nextManifest(lease.lease_id, progress.cursor);
        assert(page.lease_id === lease.lease_id && page.scope === lease.scope && sameCut(page.cut, lease.cut) && Array.isArray(page.entities), 'Manifest does not belong to this fixed cut.');
        assert(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor !== progress.cursor && page.entities.length > 0, 'Manifest cursor did not advance.');
        const counts = { ...progress.counts }; let previous: ManifestEntry | undefined = progress.last_key ? JSON.parse(progress.last_key) : undefined;
        for (const entry of page.entities) {
          assert(entryValid(entry) && (!previous || compareRef(previous, entry) < 0), 'Manifest is duplicated or out of order.');
          previous = entry; counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
          assert((counts[entry.kind] ?? 0) <= (lease.expected_entities.find(row => row.kind === entry.kind)?.count ?? 0), 'Manifest exceeded expected entity counts.');
        }
        const nextLease = { ...lease, expires_at: page.expires_at };
        await persist(state => ({ state: { ...state, baseline: { ...state.baseline!, lease: nextLease, started: true, counts,
          last_key: previous ? JSON.stringify(previous) : null, page: { entries: page.entities, next_cursor: page.next_cursor } } },
          stages: page.entities.map(entry => ({ type: 'entity', run: lease.lease_id, entry })) }));
      }
      this.assertGeneration(generation);
      const current = this.current.baseline!, entries = current.page!.entries;
      prefetch(lease.lease_id, current.page!.next_cursor);
      const cached = await this.cache.entities(this.namespace, lease.cut.dataset_epoch, entries);
      const staged = await this.cache.stagedEntities(this.namespace, lease.lease_id, entries);
      this.assertGeneration(generation);
      const missing = entries.filter((entry, index) => cached[index]?.hash !== entry.hash && staged[index]?.entity?.hash !== entry.hash);
      for (let offset = 0; offset < missing.length; offset += 100) {
        this.assertGeneration(generation);
        await this.freshLease(this.current.baseline!.lease);
        const wanted = missing.slice(offset, offset + 100), response = await this.request(() => this.transport.entities(lease.lease_id, wanted, this.abort.signal), generation);
        assert(response.lease_id === lease.lease_id && sameCut(response.cut, lease.cut) && response.entities.length === wanted.length, 'Entity batch does not match its manifest.');
        await verifyEntities(response.entities);
        const refs = new Map(wanted.map(entry => [entityKey(entry), entry]));
        for (const entity of response.entities) { const ref = refs.get(entityKey(entity)); assert(ref && ref.hash === entity.hash && ref.revision === entity.revision, 'Entity revision differs from its manifest.'); }
        await persist(state => ({ state: { ...state, baseline: { ...state.baseline!, lease: response.expires_at ? { ...state.baseline!.lease, expires_at: response.expires_at } : state.baseline!.lease } },
          stages: response.entities.map(entity => ({ type: 'entity', run: lease.lease_id, entry: refs.get(entityKey(entity))!, entity })) }));
      }
      this.assertGeneration(generation);
      const finished = this.current.baseline!;
      if (finished.page!.next_cursor !== null) {
        await persist(state => ({ state: { ...state, baseline: { ...state.baseline!, cursor: finished.page!.next_cursor, page: null } } }));
        continue;
      }
      for (const row of lease.expected_entities) assert((finished.counts[row.kind] ?? 0) === row.count, 'Incomplete snapshot count.');
      assert(Object.values(finished.counts).reduce((sum, count) => sum + count, 0) === lease.total_entities, 'Incomplete manifest chain.');
      await persist(state => ({ state: { ...state, phase: lease.scope === 'recent' ? 'recent_ready' : 'full_ready', baseline: null,
        activeLease: finished.lease, coverage: { scope: lease.scope, complete: true, cut: lease.cut, entities: lease.total_entities, sources: lease.coverage ?? null },
        appliedCommitSeq: lease.cut.commit_seq, receivedCommitSeq: lease.cut.commit_seq, lastSyncAt: new Date(this.now()).toISOString(),
        viewAt: sameCut(state.activeLease?.cut, lease.cut) ? state.viewAt : new Date(this.now()).toISOString(), error: null },
        finalizeBaseline: lease.lease_id, clearStages: [lease.lease_id], clearQueries: !!state.activeLease && !sameCut(state.activeLease.cut, lease.cut) }));
      return;
    }
    } finally {
      this.abort.signal.removeEventListener('abort', stop); localAbort.abort();
      await (ahead as { promise: Promise<ManifestResult> } | null)?.promise;
    }
  }
  private async applyStagedCommits(lease: ReadLease, generation: number) {
    const rows = (await this.cache.stages(this.namespace, lease.lease_id)).filter(row => row.type === 'commit') as StagedCommit[];
    this.assertGeneration(generation);
    const sequences = [...new Set(rows.map(row => row.seq))].sort((a, b) => a - b);
    for (const seq of sequences) {
      this.assertGeneration(generation);
      if (seq <= this.current.appliedCommitSeq) continue;
      assert(seq === this.current.appliedCommitSeq + 1, 'Changes contain a commit gap.');
      const chunks = rows.filter(row => row.seq === seq).sort((a, b) => a.chunk - b.chunk), first = chunks[0];
      if (chunks.length !== first.chunks) return;
      assert(chunks.every((row, index) => row.chunk === index && row.chunks === first.chunks && row.total === first.total), 'Inconsistent commit chunks.');
      const entities = chunks.flatMap(row => row.entities), deleted = chunks.flatMap(row => row.deleted);
      assert(entities.length + deleted.length === first.total && new Set([...entities, ...deleted].map(entityKey)).size === first.total, 'Incomplete or duplicate commit entities.');
      await this.persist(state => ({ state: { ...state, appliedCommitSeq: seq }, entities, deleted }), generation);
    }
  }
  private async delta() {
    const generation = this.generation;
    const persist = (transform: (state: CacheState) => CacheWrite) => this.persist(transform, generation);
    let lease = this.current.deltaLease;
    if (!lease) {
      lease = await this.request(() => this.transport.read('full', this.identity.deviceIds, undefined, this.abort.signal)); verifyLease(lease, 'full');
      this.assertGeneration(generation);
      const active = this.current.activeLease!.cut;
      if (lease.cut.dataset_epoch !== active.dataset_epoch || lease.cut.deletion_version !== active.deletion_version) throw new SyncError('A new baseline is required.', 'BASELINE_REQUIRED', 409);
      await persist(state => ({ state: { ...state, deltaLease: lease, phase: 'delta_loading', error: null } }));
    }
    await this.applyStagedCommits(lease, generation);
    while (this.current.appliedCommitSeq < lease.cut.commit_seq) {
      lease = await this.freshLease(lease);
      const before = this.current.appliedCommitSeq, currentLease = lease, page = await this.request(() => this.transport.changes(currentLease, before, this.abort.signal), generation);
      assert(sameCut(page.cut, lease.cut) && integer(page.next_cursor) && page.next_cursor <= lease.cut.commit_seq && Array.isArray(page.commits), 'Changes do not belong to the fixed target cut.');
      const staged: StagedCommit[] = [];
      let received = this.current.receivedCommitSeq;
      for (const commit of page.commits) {
        assert(integer(commit.commit_seq) && commit.commit_seq > before && commit.commit_seq <= lease.cut.commit_seq, 'Invalid change commit sequence.');
        await verifyEntities(commit.entities);
        assert(Array.isArray(commit.deleted) && commit.deleted.every(ref => kinds.includes(ref.kind) && typeof ref.id === 'string' && ref.id.length > 0), 'Invalid deleted entities.');
        const chunks = commit.chunk_count ?? 1, chunk = commit.chunk_index ?? 0, total = commit.entity_count ?? commit.entities.length + commit.deleted.length;
        assert(integer(chunks) && chunks > 0 && integer(chunk) && chunk < chunks && integer(total) && (commit.complete !== false || chunks > 1), 'An incomplete commit cannot be applied.');
        staged.push({ type: 'commit', run: lease.lease_id, seq: commit.commit_seq, chunk, chunks, total, entities: commit.entities, deleted: commit.deleted });
        received = Math.max(received, commit.commit_seq);
      }
      assert(staged.length > 0, 'Change cursor did not advance.');
      await persist(state => ({ state: { ...state, receivedCommitSeq: received }, stages: staged }));
      await this.applyStagedCommits(lease, generation);
      assert(this.current.appliedCommitSeq > before, 'A complete commit is still missing; retry from the saved cursor.');
      assert(page.next_cursor === this.current.appliedCommitSeq, 'Changes cursor differs from the complete applied commits.');
    }
    await persist(state => ({ state: { ...state, activeLease: lease, deltaLease: null, phase: 'full_ready', receivedCommitSeq: lease.cut.commit_seq,
      coverage: { scope: 'full', complete: true, cut: lease.cut, entities: lease.total_entities, sources: lease.coverage ?? null }, lastSyncAt: new Date(this.now()).toISOString(),
      viewAt: sameCut(state.activeLease?.cut, lease.cut) ? state.viewAt : new Date(this.now()).toISOString(), error: null },
      clearStages: [lease!.lease_id], clearQueries: !sameCut(state.activeLease?.cut, lease!.cut) }));
  }
  dispose() { this.abort.abort(new DOMException('Cloud source changed.', 'AbortError')); this.listeners.clear(); }
}
