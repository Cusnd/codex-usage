import { stableJson, type SyncCut, type SyncEntity, type EntityKind } from '../../contracts/sync.js';
import { entityKey, type ReadLease, type ManifestEntry } from "./cache.js";
import { SyncError } from './transport.js';

export const kinds: EntityKind[] = ['account', 'device', 'event', 'project', 'settings', 'thread'];

export const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

export function validCut(value: unknown): value is SyncCut {
  const cut = value as SyncCut;
  return !!cut && typeof cut.dataset_epoch === 'string' && !!cut.dataset_epoch &&
    [cut.commit_seq, cut.deletion_version, cut.organization_version, cut.config_version].every(integer);
}

export function entryValid(entry: ManifestEntry) {
    return entry && kinds.includes(entry.kind) && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 2048 && integer(entry.revision) && /^[a-f0-9]{64}$/.test(entry.hash);
}

export function assert(value: unknown, message: string): asserts value { if (!value)
    throw new SyncError(message); }

export async function entityHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyEntities(entities: SyncEntity[]) {
    assert(Array.isArray(entities), 'Invalid entity response.');
    const seen = new Set<string>();
    for (const entity of entities) {
        assert(entryValid(entity) && Object.hasOwn(entity, 'value'), 'Invalid entity envelope.');
        const key = entityKey(entity);
        assert(!seen.has(key), 'Duplicate entity response.');
        seen.add(key);
        assert(await entityHash(entity.value) === entity.hash, 'Entity content hash mismatch.');
    }
}

export function verifyLease(lease: ReadLease, scope: 'recent' | 'full') {
    assert(lease && typeof lease.lease_id === 'string' && !!lease.lease_id && validCut(lease.cut) && lease.scope === scope &&
        integer(lease.total_entities) && Number.isFinite(Date.parse(lease.expires_at)) && Array.isArray(lease.expected_entities), 'Invalid snapshot lease.');
    const seen = new Set<EntityKind>();
    for (const row of lease.expected_entities) {
        assert(kinds.includes(row.kind) && integer(row.count) && !seen.has(row.kind), 'Invalid expected entity counts.');
        seen.add(row.kind);
    }
    assert(lease.expected_entities.reduce((sum, row) => sum + row.count, 0) === lease.total_entities, 'Snapshot total does not match its per-kind counts.');
}

export const compareRef = (a: ManifestEntry, b: ManifestEntry) => {
    // SQLite's BINARY order compares UTF-8 bytes, including non-BMP identifiers.
    const left = new TextEncoder().encode(a.kind === b.kind ? a.id : a.kind), right = new TextEncoder().encode(a.kind === b.kind ? b.id : b.kind);
    for (let i = 0; i < Math.min(left.length, right.length); i++)
        if (left[i] !== right[i])
            return left[i] - right[i];
    return left.length - right.length;
};
