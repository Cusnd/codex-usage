import type { ApiResponse } from '../../contracts/responses.js';
import type { PageRead } from '../../contracts/read-lease.js';
import type { UsageDataSource, QueryView } from '../../contracts/data-source.js';
import { stableJson, type SyncCut } from '../../contracts/sync.js';
import { USAGE_QUERY_REVISION } from '../../analytics/revision.js';
import { queryParameters } from '../../foundation/query-parameters.js';
import { jsonRequest, RequestError } from './http.js';
import { namesFromProjects, referencedProjectIds, type ProjectLabelView } from './project-labels.js';

export type CloudIdentity = { origin: string; userId: string; deviceIds: string[] };
export type CloudPageState = { read: PageRead | null; refreshing: boolean; error: string | null; viewAt: number | null };
type Flight = { abort: AbortController; readers: number; settled: boolean; promise: Promise<unknown> };
const sameCut = (a: SyncCut | undefined, b: SyncCut | undefined) => !!a && !!b && stableJson(a) === stableJson(b);
export const cloudNamespace = (identity: CloudIdentity) => stableJson([identity.origin, identity.userId, [...new Set(identity.deviceIds)].sort()]);

/** Online page reads only. React Query owns result caching; this adapter stores no entity mirror or durable DTOs. */
export class CloudDataSource implements UsageDataSource {
  readonly mode = 'cloud' as const;
  readonly namespace: string;
  private current: CloudPageState = { read: null, refreshing: false, error: null, viewAt: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private accountRevision = 0;
  private disposed = false;
  private viewFlight: { abort: AbortController; promise: Promise<PageRead> } | null = null;
  private renewal: { id: string; abort: AbortController; promise: Promise<PageRead> } | null = null;
  private reads = new Map<string, Flight>();
  private labels: { cut: SyncCut; names: Record<string, string> } | null = null;
  private readonly openedAt: number;
  // The page can prepare active queries in React Query before exposing a new cut.
  prepareRefresh?: (candidate: CloudDataSource, signal: AbortSignal) => Promise<() => void>;
  discardHistory?: () => void;
  constructor(readonly identity: CloudIdentity, private request: typeof jsonRequest = jsonRequest,
    private systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, private now = Date.now) {
    this.namespace = cloudNamespace(identity);
    this.openedAt = this.now();
  }
  state = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: CloudPageState) { this.current = state; for (const listener of this.listeners) listener(); }
  private timezone(read = this.current.read) { return read?.settings.timezoneMode === 'manual' ? read.settings.timezone : this.systemTimezone(); }
  revision(route?: string) {
    return route?.startsWith('account') ? stableJson([this.identity.origin, this.identity.userId, this.accountRevision])
      : stableJson([USAGE_QUERY_REVISION, this.namespace, this.current.read?.cut, this.timezone()]);
  }
  capture(): QueryView { return { namespace: this.namespace, lease: this.current.read, generation: this.generation, timezone: this.timezone() }; }
  clock = () => this.current.viewAt ?? this.openedAt;
  private assertCurrent(generation: number, read?: PageRead, view?: QueryView) {
    if (this.disposed || generation !== this.generation || view && (view.namespace !== this.namespace || view.generation !== undefined && view.generation !== generation)
      || read && !sameCut(this.current.read?.cut, read.cut)
      || view?.lease && !sameCut(this.current.read?.cut, view.lease.cut)
      || view?.lease && view.timezone !== undefined && view.timezone !== this.timezone()) {
      throw new RequestError('页面范围已更新，请读取当前页面。', 'VIEW_CHANGED');
    }
  }
  private checkRead(read: PageRead) {
    if (read.user_id !== this.identity.userId || !read.lease_id || !read.cut || !read.settings || !Number.isFinite(Date.parse(read.expires_at))) {
      throw new RequestError('云端读取身份或版本无效。', 'VIEW_CHANGED');
    }
  }
  refresh(): Promise<PageRead> {
    this.assertCurrent(this.generation);
    if (this.viewFlight) return this.viewFlight.promise;
    let generation = this.generation;
    const abort = new AbortController();
    this.set({ ...this.current, refreshing: true, error: null });
    const flight = { abort, promise: Promise.resolve(null as unknown as PageRead) };
    flight.promise = this.request<PageRead>('/api/v3/view', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [...new Set(this.identity.deviceIds)].sort() }), signal: abort.signal }).then(async read => {
      this.assertCurrent(generation); this.checkRead(read);
      // Observations fetched while a history deletion was still running must be
      // checked again when an invalidated page becomes readable.
      if (!this.current.read && generation > 0) this.accountRevision++;
      if (this.current.read && read.cut.deletion_version !== this.current.read.cut.deletion_version) {
        // A deletion learned from another browser revokes old content even when
        // a replacement detail is now 404 or its request cannot complete.
        generation = ++this.generation;
        this.labels = null; this.accountRevision++;
        this.renewal?.abort.abort(); this.renewal = null;
        for (const flight of this.reads.values()) flight.abort.abort(); this.reads.clear();
        this.set({ read: null, refreshing: true, error: null, viewAt: null });
        this.discardHistory?.();
      }
      const next = { read, refreshing: false, error: null, viewAt: this.now() };
      if (!sameCut(this.current.read?.cut, read.cut)) {
        const candidate = new CloudDataSource(this.identity, this.request, this.systemTimezone, this.now);
        candidate.current = next;
        try {
          const commit = await this.prepareRefresh?.(candidate, abort.signal);
          this.assertCurrent(generation); abort.signal.throwIfAborted();
          commit?.(); this.labels = candidate.labels;
        } finally { candidate.dispose(); }
      }
      this.set(next); return read;
    }).catch(error => {
      if (!this.disposed && generation === this.generation) this.set({ ...this.current, refreshing: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => { if (this.viewFlight === flight) this.viewFlight = null; });
    this.viewFlight = flight; return flight.promise;
  }
  private async readView(signal?: AbortSignal): Promise<PageRead> {
    signal?.throwIfAborted();
    const read = this.current.read ?? await this.refresh();
    signal?.throwIfAborted();
    if (Date.parse(read.expires_at) > this.now() + 60_000) return read;
    if (this.renewal?.id === read.lease_id) return this.renewal.promise;
    const generation = this.generation, abort = new AbortController();
    const flight = { id: read.lease_id, abort, promise: Promise.resolve(read) };
    flight.promise = this.request<PageRead>('/api/v3/view/' + encodeURIComponent(read.lease_id) + '/renew', { method: 'POST', signal: abort.signal }).then(renewed => {
      this.assertCurrent(generation, read); this.checkRead(renewed);
      if (renewed.lease_id !== read.lease_id || !sameCut(renewed.cut, read.cut) || stableJson(renewed.settings) !== stableJson(read.settings)) {
        throw new RequestError('读取续期改变了页面版本。', 'QUERY_CUT_MISMATCH');
      }
      if (this.current.read?.lease_id === read.lease_id) this.set({ ...this.current, read: renewed });
      return renewed;
    }).finally(() => { if (this.renewal === flight) this.renewal = null; });
    this.renewal = flight; return flight.promise;
  }
  /** Share in-flight GETs without keeping a second result cache. */
  private get<T>(url: string, signal?: AbortSignal, scope = 'usage'): Promise<T> {
    signal?.throwIfAborted();
    const [path, query] = url.split('?'), search = new URLSearchParams(query); search.sort();
    const key = stableJson([this.generation, scope, path, search.toString()]);
    let flight = this.reads.get(key);
    if (!flight || flight.abort.signal.aborted) {
      const created: Flight = { abort: new AbortController(), readers: 0, settled: false, promise: Promise.resolve() };
      created.promise = Promise.resolve().then(() => this.request(url, { signal: created.abort.signal })).finally(() => {
        created.settled = true; if (this.reads.get(key) === created) this.reads.delete(key);
      });
      this.reads.set(key, created); flight = created;
    }
    const shared = flight; shared.readers++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const complete = (error: boolean, value: unknown) => {
        if (finished) return; finished = true; signal?.removeEventListener('abort', cancelled);
        shared.readers--; if (!shared.readers && !shared.settled) shared.abort.abort();
        if (error) reject(value); else resolve(value as T);
      };
      const cancelled = () => complete(true, signal?.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      shared.promise.then(value => complete(false, value), error => complete(true, error));
      if (signal?.aborted) cancelled();
    });
  }
  projectName(id: string) { return sameCut(this.labels?.cut, this.current.read?.cut) ? this.labels?.names[id] : undefined; }
  private async loadLabels(read: PageRead, ids: string[], generation: number, signal?: AbortSignal) {
    if (!ids.length || sameCut(this.labels?.cut, read.cut) && ids.every(id => Object.hasOwn(this.labels!.names, id))) return;
    const result = await this.get<ProjectLabelView>('/api/v3/projects?lease_id=' + encodeURIComponent(read.lease_id), signal);
    this.assertCurrent(generation, read);
    if (!sameCut(result.cut, read.cut) || result.lease_id !== read.lease_id || !Array.isArray(result.projects) || !result.aliases) {
      throw new RequestError('项目名称不属于当前页面版本。', 'PROJECT_CUT_MISMATCH');
    }
    this.labels = { cut: read.cut, names: namesFromProjects(result.projects, result.aliases, result.sources) };
  }
  invalidateAccounts() { this.accountRevision++; this.set({ ...this.current }); }
  async query<T>(route: string, input: Record<string, unknown> = {}, signal?: AbortSignal, view?: QueryView): Promise<ApiResponse<T>> {
    const generation = this.generation, accountRevision = this.accountRevision;
    this.assertCurrent(generation); signal?.throwIfAborted();
    if (route.startsWith('account')) {
      if (view && stableJson(JSON.parse(view.namespace).slice(0, 2)) !== stableJson([this.identity.origin, this.identity.userId])) {
        throw new RequestError('账户读取身份已变化。', 'VIEW_CHANGED');
      }
      const params = { ...input }; delete params.deviceIds;
      const search = queryParameters(params), prefix = route === 'account/cloud' ? '/api/v3/accounts' : '/api/v3/usage/' + route;
      const result = await this.get<ApiResponse<T> & { user_id?: string; accounts?: T }>(prefix + (search.size ? '?' + search : ''), signal, 'account:' + accountRevision);
      this.assertCurrent(generation);
      if (accountRevision !== this.accountRevision || result.user_id !== this.identity.userId) throw new RequestError('账户读取身份或版本已变化。', 'VIEW_CHANGED');
      return result.accounts === undefined ? result : { data: result.accounts, meta: { source: 'account', updatedAt: null, timezone: 'UTC', warnings: [] } };
    }
    this.assertCurrent(generation, undefined, view);
    let attemptedRead: PageRead | undefined;
    try {
      const read = await this.readView(signal);
      attemptedRead = read;
      // A first read learns server settings; later captured views must remain unchanged.
      const captured = view?.lease ? view : { ...view, namespace: this.namespace, lease: read, timezone: this.timezone(read) };
      this.assertCurrent(generation, read, captured);
      if (route === 'settings') return { data: { ...read.settings, timezone: this.timezone(read) } as T,
        meta: { source: 'cloud', updatedAt: null, timezone: this.timezone(read), warnings: [], cut: read.cut } } as ApiResponse<T>;
      const params = { ...input, timezone: captured.timezone };
      if (view?.rolling && typeof input.to === 'string') Object.assign(params, { to: new Date(this.clock()).toISOString() });
      const search = queryParameters(params); search.set('lease_id', read.lease_id);
      const result = await this.get<ApiResponse<T>>('/api/v3/usage/' + route + '?' + search, signal);
      this.assertCurrent(generation, read, captured);
      if (!sameCut((result.meta as unknown as { cut?: SyncCut }).cut, read.cut)) throw new RequestError('统计结果不属于当前页面版本。', 'QUERY_CUT_MISMATCH');
      await this.loadLabels(read, referencedProjectIds(result.data, input.project), generation, signal);
      signal?.throwIfAborted(); this.assertCurrent(generation, read, captured); return result;
    } catch (error) {
      if (error instanceof RequestError && error.code === 'BASELINE_REQUIRED') {
        this.assertCurrent(generation, attemptedRead, view?.lease ? view : undefined);
        this.invalidate(); this.discardHistory?.();
        await this.refresh();
        // Publish one new read for every sibling query; never return a new cut under an old query key.
        throw new RequestError('读取版本已更新，正在重新加载页面。', 'VIEW_CHANGED');
      }
      throw error;
    }
  }
  invalidate() {
    this.generation++; this.accountRevision++; this.labels = null;
    this.viewFlight?.abort.abort(); this.viewFlight = null; this.renewal?.abort.abort(); this.renewal = null;
    for (const flight of this.reads.values()) flight.abort.abort(); this.reads.clear();
    this.set({ read: null, refreshing: false, error: null, viewAt: null });
  }
  dispose() { this.disposed = true; this.invalidate(); this.listeners.clear(); }
  async mutate<T>(route: string, body: unknown, method = 'POST'): Promise<ApiResponse<T>> {
    this.assertCurrent(this.generation);
    if (route === 'refresh') {
      const source = (body as { source?: string })?.source;
      if (source === 'account' || source === 'all') this.invalidateAccounts();
      if (source !== 'account') await this.refresh();
      return { data: this.current as T, meta: { source: 'cloud', updatedAt: null, timezone: this.timezone(), warnings: [] } };
    }
    const generation = this.generation;
    const payload = route === 'settings' && method === 'PATCH' ? { ...body as object, operation_id: crypto.randomUUID(),
      ...(this.current.read ? { base_config_version: this.current.read.cut.config_version } : {}) } : body;
    const result = await this.request<ApiResponse<T> & { settings?: T }>(route === 'settings' ? '/api/v3/settings' : '/api/v3/usage/' + route,
      { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    this.assertCurrent(generation);
    // A read started before this write cannot confirm the newly saved settings.
    await this.viewFlight?.promise.catch(() => {});
    this.assertCurrent(generation); await this.refresh();
    return result.settings !== undefined && result.data === undefined ? { data: result.settings,
      meta: { source: 'cloud', updatedAt: null, timezone: this.timezone(), warnings: [] } } : result;
  }
}
