import type { Observation, ExtractionContext, SourceKind } from "../usage/types.js";
import { SYNC_PROTOCOL, SYNC_SCHEMA } from "./sync-version.js";

export { EXTRACTOR_VERSION } from './sync-version.js';

export const SYNC_V3 = SYNC_PROTOCOL;

export const V3_CONTENT_TYPE = 'application/vnd.codex-usage.v3+json+gzip';

export const V3_MAX_WIRE_BYTES = 512 * 1024;

export const V3_MAX_DECODED_BYTES = 1024 * 1024;

export const V3_MAX_RECORDS = 500;

export const V3_TARGET_BYTES = 512 * 1024;

export type Lane = 'live' | 'backfill';

export type SourceCheckpoint = {
  source_id: string; generation: number; kind: SourceKind;
  from_cursor: number; to_cursor: number; snapshot_eof: number;
  context_hash: string; context: ExtractionContext;
  replace_start: boolean; replace_end: boolean; generation_complete: boolean;
  available: boolean; trailing_bytes: number;
};

export type SyncMetadata =
  | { type: 'source_availability'; source_id: string; available: boolean }
  | { type: 'project'; source_project_id: string; value: Record<string, unknown> };

export type UploadBatch = {
  protocol: typeof SYNC_PROTOCOL; schema_version: typeof SYNC_SCHEMA; extractor_version: number;
  collector_id: string; producer_epoch: string; lane: Lane; lane_seq: number;
  batch_id: string; records_hash: string; sources: SourceCheckpoint[];
  records: Observation[]; metadata: SyncMetadata[];
};

export type UploadAck = {
  batch_id: string; wire_hash: string; records_hash: string;
  status: 'received' | 'applied'; received_at: string;
  dataset_epoch: string; applied_commit_seq: number | null;
  contiguous_received_seq: number; contiguous_applied_seq: number;
  retry_after_ms: number; current_config_version: number;
};

export type SyncCut = { dataset_epoch: string; commit_seq: number; deletion_version: number; organization_version: number; config_version: number };

export type EntityKind = 'event' | 'thread' | 'project' | 'device' | 'settings' | 'account';

export type SyncEntity = { kind: EntityKind; id: string; revision: number; hash: string; value: unknown };

export type SnapshotManifestPage = { lease_id: string; cut: SyncCut; scope: 'recent' | 'full'; entities: Omit<SyncEntity, 'value'>[]; next_cursor: string | null; expires_at: string };

export type ChangesPage = { cut: SyncCut; commits: { commit_seq: number; entities: SyncEntity[]; deleted: {kind:EntityKind;id:string}[] }[]; next_cursor: number; more: boolean };

export { stableJson } from '../foundation/stable-json.js';
