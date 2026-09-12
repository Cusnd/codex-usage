import { type SyncCut, type EntityKind } from './sync.js';
import type { Settings } from "./index.js";

export type ReadLease = {
  lease_id: string; cut: SyncCut; scope: 'recent' | 'full'; expected_entities: { kind: EntityKind; count: number }[];
  total_entities: number; expires_at: string; coverage?: unknown; settings?: Settings;
  selection?: { from_at: string | null; include_active: boolean };
};
