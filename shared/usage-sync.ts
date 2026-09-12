import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AccountUsage } from './contracts.js';
import type { CloudSnapshot } from './cloud.js';

export const USAGE_PROTOCOL = 2;
export type CloudUsageFilter = { deviceIds?: string[] };
export type UsageCapabilities = { mode:'local'|'cloud'|'showcase';deviceFilter:boolean;localControl:boolean;refresh:'collect'|'read'|'example' };
export const USAGE_PARSER_VERSION = 1;
export const SYNC_CHUNK_EVENTS = 200;
export const SYNC_BODY_BYTES = 262144;
const text = Type.String({ maxLength: 8192 });
const id = Type.String({ minLength: 1, maxLength: 256 });
const nullable = (schema: ReturnType<typeof Type.String>) => Type.Union([schema, Type.Null()]);
const integer = Type.Union([Type.String({ pattern: '^[0-9]{1,19}$' }), Type.Null()]);
const timestamp = Type.String({ pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' });
export const SyncThreadSchema = Type.Object({
  id, title: nullable(text), titleUpdatedAt: nullable(timestamp), project: nullable(text),
  source: nullable(text), parentId: nullable(id), subagentParentId: nullable(id), forkedFromId: nullable(id),
}, { additionalProperties: false });
export const SyncEventSchema = Type.Object({
  event_key: id, thread_id: id, turn_id: nullable(id), response_id: nullable(id), at: timestamp,
  project: nullable(text), model: nullable(id), effort: nullable(id),
  kind: Type.Union([Type.Literal('record'), Type.Literal('legacy')]),
  incomplete: Type.Integer({ minimum: 0, maximum: 1 }),
  input_tokens: integer, cached_input_tokens: integer, cache_write_input_tokens: integer,
  output_tokens: integer, reasoning_output_tokens: integer, total_tokens: integer,
}, { additionalProperties: false });
export const SyncManifestSchema = Type.Object({
  schemaVersion: Type.Literal(2), datasetId: id, thread: SyncThreadSchema,
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  parserVersion: Type.Integer({ minimum: 1, maximum: 10000 }), collectedAt: timestamp,
  eventCount: Type.Integer({ minimum: 0, maximum: 10000000 }),
  chunkCount: Type.Integer({ minimum: 1, maximum: 100000 }),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false });
export const SyncChunkSchema = Type.Object({
  manifest: SyncManifestSchema, index: Type.Integer({ minimum: 0 }),
  events: Type.Array(SyncEventSchema, { maxItems: SYNC_CHUNK_EVENTS }),
}, { additionalProperties: false });
export type SyncThread = Static<typeof SyncThreadSchema>;
export type SyncEvent = Static<typeof SyncEventSchema>;
export type SyncManifest = Static<typeof SyncManifestSchema>;
export type SyncChunk = Static<typeof SyncChunkSchema>;
export function validChunk(value: unknown): value is SyncChunk {
  if (!Value.Check(SyncChunkSchema, value)) return false;
  if (value.index >= value.manifest.chunkCount || !Number.isFinite(Date.parse(value.manifest.collectedAt))) return false;
  return value.events.every(event => event.thread_id === value.manifest.thread.id &&
    Number.isFinite(Date.parse(event.at)) && Object.entries(event).every(([key, v]) =>
      !key.endsWith('_tokens') || v === null || BigInt(v) <= 9223372036854775807n));
}
export type CloudAccountSnapshot = {
  schemaVersion: 2; quota: CloudSnapshot;
  history: Omit<AccountUsage, 'accountId'> | null;
  historyCollectedAt: string | null;
};
export type CloudSource = {
  id: string; name: string; boundAt: string; protocol: number; paused: boolean; revoked: boolean; historyDeleted: boolean;
  collectedAt: string | null; receivedAt: string | null; coverageFrom: string | null; coverageTo: string | null;
  // V3 syncedThreads counts sessions whose latest source generation is complete and available;
  // totalThreads is the latest collector report. These are not a progress ratio.
  syncedThreads: number; totalThreads: number | null; initialComplete: boolean; error: string | null;
  // V3 retained cloud sessions, including unavailable sources and protected old generations.
  retainedThreads?: number;
  appliedAt?: string | null;
  historyDeleting?: boolean;
  deletionStatus?: 'retained' | 'deleting' | 'deleted' | 'failed';
  sourceCounts?: { known: number; complete: number; unavailable: number; pendingBatches: number };
};
export type CloudAccountView = {
  accountRef: string; deviceId: string; deviceName: string; receivedAt: string; stale: boolean;
  quota: CloudSnapshot; history: Omit<AccountUsage, 'accountId'> | null; historyCollectedAt: string | null;
  // Optional for already cached responses produced before history provenance was exposed.
  historyMeta?: {
    summarySource: CloudHistorySource;
    dailySources: (CloudHistorySource & { dates: string[] })[];
  };
};
export type CloudHistorySource = {
  deviceId: string; deviceName: string; collectedAt: string | null; receivedAt: string; stale: boolean;
};
