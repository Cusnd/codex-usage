import type { SyncCut, EntityKind } from '../../../modules/contracts/sync.js';
import type { Settings } from '../../../modules/contracts/settings.js';

// Frozen entity-mirror lease, including completion counts absent from PageRead.
export type ReadLease = {
  lease_id: string; cut: SyncCut; scope: 'recent' | 'full'; expected_entities: { kind: EntityKind; count: number }[];
  total_entities: number; expires_at: string; coverage?: unknown; settings?: Settings;
  selection?: { from_at: string | null; include_active: boolean };
};
