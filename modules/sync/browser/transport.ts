import { type ChangesPage, type SnapshotManifestPage, type SyncCut, type SyncEntity } from '../../contracts/sync.js';
import { SYNC_HEADER, SYNC_VERSION, assertCloudVersion, VERSION_MISMATCH } from "../../contracts/cloud-version.js";
import { type ReadLease, type ManifestEntry } from "./cache.js";

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
