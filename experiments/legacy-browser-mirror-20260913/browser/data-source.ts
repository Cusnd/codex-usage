import type { ApiResponse } from '../../../modules/contracts/responses.js';
import { stableJson, type SyncEntity, type SyncCut } from '../../../modules/contracts/sync.js';
import { USAGE_QUERY_REVISION } from "../../../modules/analytics/revision.js";
import { CloudSyncController, jsonRequest, SyncError } from "./controller.js";
import { sameCut, queryLeaseOf, type ReadLease, type EntityRef } from "./cache.js";
import { labelsFromEntities, namesFromProjects, referencedProjectIds, type ProjectLabelView } from "./project-labels.js";
import { type UsageDataSource, type QueryView } from '../contracts/data-source.js';
import { queryParameters } from '../../../modules/foundation/query-parameters.js';

const canonicalParams = (params: Record<string, unknown>, account: boolean) => Object.fromEntries(Object.entries(params)
  .filter(([key, value]) => (!account || key !== 'deviceIds') && value !== undefined && value !== null && value !== '')
  .map(([key, value]) => [key, key === 'deviceIds' || key === 'unknowns' ? [...new Set(Array.isArray(value) ? value : [value])].sort() : value]));

export class OfflineCacheMiss extends Error {
  readonly code = 'OFFLINE_CACHE_MISS';
  constructor() { super('当前离线缓存中没有这一页或筛选结果。联网后打开该查询即可保存，缺少缓存不代表用量为零。'); }
}
type ReadFlight = { abort: AbortController; readers: number; settled: boolean; promise: Promise<unknown> };

export class CloudUsageDataSource implements UsageDataSource {
  readonly mode = 'cloud' as const;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.controller.subscribe(listener);
    return () => { this.listeners.delete(listener); unsubscribe(); };
  };
  private notify() { for (const listener of this.listeners) listener(); }
  private accountRefresh = 0;
  private accountWrites: Promise<void> = Promise.resolve();
  private labels: { cut: SyncCut; names: Record<string, string> } | null = null;
  private reads = new Map<string, ReadFlight>();
  constructor(readonly controller: CloudSyncController, private request: typeof jsonRequest = jsonRequest, private online = () => typeof navigator === 'undefined' || navigator.onLine !== false, private systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {}
  /** Share transport work, while each page keeps its own cancellation and view validation. */
  private get<T>(url: string, signal?: AbortSignal, generation = 'usage'): Promise<T> {
    signal?.throwIfAborted();
    const [path, query] = url.split('?'), search = new URLSearchParams(query); search.sort();
    const key = stableJson([generation, path, search.toString()]);
    let flight = this.reads.get(key);
    if (!flight || flight.abort.signal.aborted) {
      const created: ReadFlight = { abort: new AbortController(), readers: 0, settled: false, promise: Promise.resolve() };
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
        shared.readers--; if (!shared.readers && !shared.settled) shared.abort.abort(new DOMException('No page is waiting for this request.', 'AbortError'));
        if (error) reject(value); else resolve(value as T);
      };
      const cancelled = () => complete(true, signal?.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      shared.promise.then(value => complete(false, value), error => complete(true, error));
      if (signal?.aborted) cancelled();
    });
  }
  private timezone(lease: ReadLease | null) { return lease?.settings?.timezoneMode === 'manual' ? lease.settings.timezone : this.systemTimezone(); }
  revision() { const lease=this.controller.queryLease();return stableJson([USAGE_QUERY_REVISION, this.controller.namespace, lease?.cut ?? null, this.accountRefresh, this.timezone(lease)]); }
  capture(): QueryView { const lease=this.controller.queryLease();return { namespace: this.controller.namespace, lease, timezone:this.timezone(lease) }; }
  clock = () => this.controller.state().viewAt ? Date.parse(this.controller.state().viewAt!) : Date.now();
  invalidateAccounts() {
    this.accountRefresh++;
    this.accountWrites = this.accountWrites.catch(() => {}).then(() => this.controller.cache.refreshAccounts(this.controller.namespace));
    this.accountWrites.catch(() => {}); this.notify();
  }
  projectName(id: string) { return sameCut(this.labels?.cut, this.controller.queryLease()?.cut) ? this.labels?.names[id] : undefined; }
  private async loadProjectLabels(lease: ReadLease, ids: string[], signal?: AbortSignal, allowNetwork = true) {
    if (!ids.length) return;
    const key = stableJson(['project-labels', lease.cut]);
    let labels = sameCut(this.labels?.cut, lease.cut) ? this.labels : null;
    if (!labels) {
      const cached = await this.controller.cache.query(this.controller.namespace, key);
      labels = { cut: lease.cut, names: Object.assign(Object.create(null), cached?.response.data ?? {}) };
    }
    const missing = () => ids.filter(id => !Object.hasOwn(labels.names, id));
    if (!missing().length) { await this.assertStoredView(lease); this.labels = labels; return; }
    const state = await this.controller.cache.state(this.controller.namespace);
    // A delta may already have changed entity bodies while pages still display the previous cut.
    if (sameCut(state?.activeLease?.cut, lease.cut) && state?.appliedCommitSeq === lease.cut.commit_seq) {
      const rows: (SyncEntity | undefined)[] = [], seen = new Set<string>(); let pending = missing();
      for (let depth = 0; pending.length && depth < 32; depth++) {
        const current = pending.filter(id => !seen.has(id)); if (!current.length) break; current.forEach(id => seen.add(id));
        rows.push(...await this.controller.cache.entities(this.controller.namespace, lease.cut.dataset_epoch,
          current.flatMap(id => [{ kind: 'project' as const, id: 'logical:' + id }, { kind: 'project' as const, id: 'alias:' + id }])));
        const resolved = labelsFromEntities(rows);
        pending = Object.values(resolved.aliases).filter(id => !seen.has(id));
      }
      const after = await this.controller.cache.state(this.controller.namespace);
      if (sameCut(after?.activeLease?.cut, lease.cut) && after?.appliedCommitSeq === lease.cut.commit_seq) Object.assign(labels.names, labelsFromEntities(rows).names);
    }
    if (missing().length && allowNetwork && this.online()) {
      const response = await this.get<ProjectLabelView>('/api/v3/projects?lease_id=' + encodeURIComponent(lease.lease_id), signal);
      if (!sameCut(response.cut, lease.cut) || response.lease_id !== lease.lease_id || !Array.isArray(response.projects) || !response.aliases || typeof response.aliases !== 'object') {
        throw new SyncError('Project labels do not match the requested page cut.', 'PROJECT_CUT_MISMATCH');
      }
      Object.assign(labels.names, namesFromProjects(response.projects, response.aliases, response.sources));
    }
    signal?.throwIfAborted(); await this.assertStoredView(lease);
    if (sameCut(this.labels?.cut, lease.cut)) labels.names = Object.assign(Object.create(null), this.labels?.names, labels.names);
    this.labels = labels;
    await this.controller.cache.putQuery(this.controller.namespace, { key, cut: lease.cut, cachedAt: new Date().toISOString(),
      response: { data: { ...labels.names }, meta: { source: 'cloud', updatedAt: null, timezone: 'UTC', warnings: [] } } });
  }
  private assertView(lease: ReadLease, view?: QueryView) {
    if (view && view.namespace !== this.controller.namespace || !sameCut(this.controller.queryLease()?.cut, lease.cut)) {
      throw new SyncError('The cloud view changed while this page was loading.', 'VIEW_CHANGED');
    }
    if(view?.timezone!==undefined&&view.timezone!==this.timezone(lease))throw new SyncError('The display time zone changed while this page was loading.', 'VIEW_CHANGED');
  }
  private async assertStoredView(lease: ReadLease, view?: QueryView) {
    this.assertView(lease, view);
    const saved = await this.controller.cache.state(this.controller.namespace);
    if (!sameCut(queryLeaseOf(saved)?.cut, lease.cut)) throw new SyncError('The saved cloud view changed in another tab.', 'VIEW_CHANGED');
  }
  private async accountQuery<T>(route: string, input: Record<string, unknown>, signal?: AbortSignal, view?: QueryView): Promise<ApiResponse<T>> {
    signal?.throwIfAborted(); await this.accountWrites;
    const namespace = this.controller.namespace, cache = this.controller.cache;
    if (view && stableJson(JSON.parse(view.namespace).slice(0, 2)) !== stableJson(JSON.parse(namespace).slice(0, 2))) {
      throw new SyncError('The account user changed while this page was loading.', 'VIEW_CHANGED');
    }
    const params = canonicalParams(input, true), key = stableJson(['account', route, params]);
    const saved = await cache.account(namespace, key);
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      if ((await cache.account(namespace, key)).generation !== saved.generation) throw new SyncError('The saved account view changed during refresh or deletion.', 'VIEW_CHANGED');
    };
    // Refresh marks the stable entry stale without losing the latest available offline observation.
    if (saved.query && (!this.online() || saved.query.generation === saved.generation)) {
      await assertCurrent(); return this.withCacheMeta(saved.query.response as ApiResponse<T>, !this.online(), saved.query.cachedAt, true);
    }
    if (!this.online()) throw new OfflineCacheMiss();
    const search = queryParameters(params), prefix = route === 'account/cloud' ? '/api/v3/accounts' : '/api/v3/usage/' + route;
    const body = await this.get<ApiResponse<T> & { accounts?: T; user_id?: string }>(prefix + (search.size ? '?' + search : ''), signal, saved.generation);
    if (body.user_id !== this.controller.identity.userId) throw new SyncError('The cloud user changed while this account page was loading.', 'VIEW_CHANGED');
    const result: ApiResponse<T> = body.accounts !== undefined ? { data: body.accounts, meta: { source: 'account', updatedAt: null, timezone: 'UTC', warnings: [] } } : body;
    signal?.throwIfAborted(); const at = new Date().toISOString();
    if (!await cache.putAccount(namespace, saved.generation, { key, response: result as ApiResponse<unknown>, cachedAt: at })) {
      throw new SyncError('The saved account view changed during refresh or deletion.', 'VIEW_CHANGED');
    }
    await assertCurrent(); return this.withCacheMeta(result, false, at, true);
  }
  async query<T>(route: string, input: Record<string, unknown> = {}, signal?: AbortSignal, view?: QueryView): Promise<ApiResponse<T>> {
    if (route.startsWith('account')) return this.accountQuery(route, input, signal, view);
    await this.controller.initialize(); signal?.throwIfAborted();
    const params = canonicalParams(input, false);
    const lease = view?.lease ?? this.controller.queryLease() ?? (this.online() ? await this.controller.view(signal) : null);
    if (!lease) throw new OfflineCacheMiss();
    // App's existing settings query checks every minute and on window focus. Resolving
    // the browser zone here gives it a new cache key without acquiring a newer cut.
    const timezone=view?.timezone??this.timezone(lease);view={...view,namespace:view?.namespace??this.controller.namespace,lease,timezone};params.timezone=timezone;
    this.assertView(lease, view);
    if (view?.rolling && typeof params.to === 'string') params.to = new Date(this.clock()).toISOString();
    const key = stableJson([USAGE_QUERY_REVISION, lease.cut, route, params]);
    const cached = await this.controller.cache.query(this.controller.namespace, key);
    signal?.throwIfAborted(); await this.assertStoredView(lease, view);
    if (cached) {
      await this.loadProjectLabels(lease, referencedProjectIds(cached.response.data, params.project), signal, false);
      return this.withCacheMeta(cached.response as ApiResponse<T>, !this.online(), cached.cachedAt, false, lease);
    }
    if (!this.online()) throw new OfflineCacheMiss();
    let activeLease: ReadLease = lease;
    const prefix = route === 'settings' ? '/api/v3/settings' : '/api/v3/usage/' + route;
    const read = async (target: ReadLease) => {
      activeLease = target;
      const search = queryParameters(params); search.set('lease_id', target.lease_id);
      const result = await this.get<ApiResponse<T>>(prefix + (search.size ? '?' + search : ''), signal);
      const cut = (result.meta as unknown as { cut?: unknown }).cut;
      if (stableJson(cut) !== stableJson(lease.cut)) throw new SyncError('The page response does not match its requested cut.', 'QUERY_CUT_MISMATCH');
      return result;
    };
    let result: ApiResponse<T>;
    try {
      result = await read(await this.controller.renewView(lease));
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'BASELINE_REQUIRED') throw error;
      signal?.throwIfAborted();
      const recovered = await this.controller.recoverView(lease);
      // A changed cut publishes a new revision for the whole page. Never mix its
      // response with sibling queries still holding the previous captured view.
      signal?.throwIfAborted(); await this.assertStoredView(lease, view);
      try { result = await read(recovered); }
      catch (retryError) {
        if (retryError instanceof SyncError && retryError.code === 'BASELINE_REQUIRED') throw new SyncError('云端读取版本暂不可用，请稍后重试刷新；已有离线页面仍可查看。', retryError.code, retryError.status);
        throw retryError;
      }
    }
    signal?.throwIfAborted(); await this.assertStoredView(lease, view);
    await this.loadProjectLabels(activeLease, referencedProjectIds(result.data, params.project), signal);
    const at = new Date().toISOString();
    await this.controller.cache.putQuery(this.controller.namespace, { key, cut: lease.cut, response: result as ApiResponse<unknown>, cachedAt: at });
    await this.assertStoredView(lease, view);
    return this.withCacheMeta(result, false, at, false, lease);
  }
  private withCacheMeta<T>(response: ApiResponse<T>, offline: boolean, at: string, account: boolean, lease?: ReadLease): ApiResponse<T> {
    const result = structuredClone(response);
    if (offline) result.meta.warnings = [...new Set([...result.meta.warnings, '离线显示此前缓存的结果。'])];
    Object.assign(result.meta, { browserCache: { offline, cachedAt: at, ...(account ? { domain: 'account-observation' } : {
      queryCut: lease!.cut, entityCacheCut: this.controller.state().coverage?.cut ?? null, appliedCommitSeq: this.controller.state().appliedCommitSeq,
    }) } });
    return result;
  }
  async entity(ref: EntityRef): Promise<{ entity: SyncEntity; appliedCommitSeq: number } | undefined> {
    await this.controller.initialize(); const state = this.controller.state(); if (!state.activeLease) return undefined;
    const [entity] = await this.controller.cache.entities(this.controller.namespace, state.activeLease.cut.dataset_epoch, [ref]);
    return entity ? { entity, appliedCommitSeq: state.appliedCommitSeq } : undefined;
  }
  async mutate<T>(route: string, body: unknown, method = 'POST'): Promise<ApiResponse<T>> {
    if (route === 'refresh') {
      const source = (body as { source?: string })?.source;
      if (source === 'account' || source === 'all') { this.invalidateAccounts(); await this.accountWrites; }
      if (source !== 'account') await this.controller.trigger('manual');
      return { data: this.controller.state() as T, meta: { source: 'cloud', updatedAt: this.controller.state().lastSyncAt, timezone: 'UTC', warnings: [] } };
    }
    const mutationBody = route === 'settings' && method === 'PATCH' ? { ...body as object, operation_id: crypto.randomUUID(),
      ...(this.controller.queryLease() ? { base_config_version: this.controller.queryLease()!.cut.config_version } : {}) } : body;
    const result = await this.request<ApiResponse<T> & { settings?: T; config_version?: number }>(route === 'settings' ? '/api/v3/settings' : '/api/v3/usage/' + route,
      { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutationBody) });
    await this.controller.trigger('manual');
    if (route === 'settings' && result.settings !== undefined && result.data === undefined) {
      return { data: result.settings, meta: { source: 'cloud', updatedAt: this.controller.state().lastSyncAt, timezone: 'UTC', warnings: [] } };
    }
    return result;
  }
}
