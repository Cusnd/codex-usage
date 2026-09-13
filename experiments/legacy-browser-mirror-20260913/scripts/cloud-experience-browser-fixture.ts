import { CloudSyncController, entityHash, SyncError, HttpSyncTransport, type SyncTransport, type ChangeResponse } from '../browser/controller.js';
import { MemoryCloudCache, type ManifestEntry, type ReadLease } from '../browser/cache.js';
import type { SyncEntity, SnapshotManifestPage } from '../../../modules/contracts/sync.js';

export const identity = { origin: 'https://cloud-experience.invalid', userId: 'experience-user', deviceIds: [] as string[] };
export const fixedNow = Date.parse('2026-09-12T18:00:00Z');
export const cut = { dataset_epoch: 'experience-epoch', commit_seq: 1, deletion_version: 0, organization_version: 0, config_version: 0 };
export class ExperienceTransport implements SyncTransport {
  rows: SyncEntity[] = []; recentCount = 200; now = fixedNow; delayMs = 0; mode = 'ready'; head = { ...cut };
  counts = { status: 0, read: 0, renew: 0, manifest: 0, entities: 0, changes: 0 };
  activeBodies = 0; maximumBodies = 0; invalid = new Set<string>();
  leases = new Map<string, ReadLease>();
  async wait(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.delayMs) await new Promise<void>((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(finish, this.delayMs), cancel = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    signal?.throwIfAborted();
  }
  async status(signal?: AbortSignal) { this.counts.status++; await this.wait(signal); return { user_id: identity.userId, cut: this.head, mode: this.mode }; }
  async read(scope: 'recent' | 'full', _ids: string[], from?: string, signal?: AbortSignal): Promise<ReadLease> {
    this.counts.read++; const id = 'lease-' + this.counts.read; await this.wait(signal);
    const count = scope === 'recent' ? Math.min(this.recentCount, this.rows.length) : this.rows.length;
    const lease: ReadLease = { lease_id: id, scope, cut: { ...(from ? this.leases.get(from)!.cut : this.head) }, expires_at: new Date(this.now + 900_000).toISOString(),
      expected_entities: count ? [{ kind: 'event', count }] : [], total_entities: count,
      settings: { timezone: 'UTC', timezoneMode: 'manual', localInterval: 60, accountInterval: 300 } };
    this.leases.set(id, lease); return structuredClone(lease);
  }
  async renew(id: string, signal?: AbortSignal) {
    this.counts.renew++; await this.wait(signal);
    if (this.invalid.has(id)) throw new SyncError('Expired lease', 'BASELINE_REQUIRED', 409);
    const lease = this.leases.get(id)!; lease.expires_at = new Date(this.now + 900_000).toISOString(); return { cut: lease.cut, expires_at: lease.expires_at };
  }
  async manifest(id: string, cursor: string | null, signal?: AbortSignal, limit = 200): Promise<SnapshotManifestPage> {
    this.counts.manifest++; await this.wait(signal);
    const lease = this.leases.get(id)!, start = Number(cursor ?? 0), rows = this.rows.slice(0, lease.total_entities);
    return { lease_id: id, scope: lease.scope, cut: lease.cut, expires_at: lease.expires_at,
      entities: rows.slice(start, start + limit).map(({ value: _, ...entry }) => entry), next_cursor: start + limit < rows.length ? String(start + limit) : null };
  }
  async entities(id: string, entries: ManifestEntry[], signal?: AbortSignal) {
    this.counts.entities++; this.activeBodies++; this.maximumBodies = Math.max(this.maximumBodies, this.activeBodies);
    try { await this.wait(signal); const lease = this.leases.get(id)!;
      return { lease_id: id, cut: lease.cut, expires_at: lease.expires_at, entities: entries.map(entry => this.rows[Number(entry.id)]) };
    } finally { this.activeBodies--; }
  }
  async changes(lease: ReadLease, _after: number, signal?: AbortSignal): Promise<ChangeResponse> { this.counts.changes++; await this.wait(signal); return { cut: lease.cut, commits: [], next_cursor: lease.cut.commit_seq, more: false }; }
  http() {
    return new HttpSyncTransport(async <T>(address: string, init: RequestInit = {}): Promise<T> => {
      const url = new URL(address, identity.origin), signal = init.signal ?? undefined, body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname.endsWith('/status')) return await this.status(signal) as T;
      if (url.pathname.endsWith('/changes')) return await this.changes(this.leases.get(url.searchParams.get('lease_id')!)!, Number(url.searchParams.get('after')), signal) as T;
      if (url.pathname.endsWith('/read')) return await this.read(body.scope, body.device_ids, body.from_lease_id, signal) as T;
      const id = decodeURIComponent(url.pathname.split('/').at(-2)!);
      if (url.pathname.endsWith('/renew')) return await this.renew(id, signal) as T;
      if (url.pathname.endsWith('/manifest')) return await this.manifest(id, url.searchParams.get('cursor'), signal, Number(url.searchParams.get('limit'))) as T;
      if (url.pathname.endsWith('/entities')) return await this.entities(id, body.entities, signal) as T;
      throw new Error('Unexpected fixture URL: ' + address);
    });
  }
}
export async function setupExperience(count = 0, autoFull = true, delayMs = 0) {
  const transport = new ExperienceTransport(), cache = new MemoryCloudCache();
  const value = { total_tokens: '9007199254740993', text: 'x'.repeat(256) }, hash = await entityHash(value);
  transport.rows = Array.from({ length: count }, (_, i) => ({ kind: 'event', id: String(i).padStart(6, '0'), revision: 1, hash, value }));
  transport.delayMs = delayMs;
  const controller = new CloudSyncController({ cache, identity, transport: transport.http(), autoFull, now: () => transport.now });
  return { controller, transport, cache };
}
