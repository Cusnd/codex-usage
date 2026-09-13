import { type SyncCut, type EntityKind } from './sync.js';
import type { Settings } from "./index.js";

/** A fixed published view for online page queries; no entity mirror metadata. */
export type PageRead = {
  user_id: string;
  lease_id: string;
  cut: SyncCut;
  settings: Settings;
  expires_at: string;
};

export type ReadLease = {
  lease_id: string; cut: SyncCut; scope: 'recent' | 'full'; expected_entities: { kind: EntityKind; count: number }[];
  total_entities: number; expires_at: string; coverage?: unknown; settings?: Settings;
  selection?: { from_at: string | null; include_active: boolean };
};
