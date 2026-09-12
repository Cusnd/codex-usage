/** Portable business values. Token values never pass through floating point arithmetic. */
export const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'] as const;
export type TokenField = typeof TOKEN_FIELDS[number];
export type Tokens = Record<TokenField, string | null>;
export type SourceKind = 'session' | 'titles';
export type ServiceTier = 'standard' | 'fast' | 'unknown';
export type ServiceTierSource = 'record' | 'settings' | 'unknown';
/** Configured mode is evidence for estimation; it is not a server billing receipt. */
export type ServiceTierState = {
  configured: ServiceTier; active_turn_id: string | null; turn_tier: ServiceTier;
  ambiguous: boolean; revision: number;
};
export type OriginEvidence = {
  device_id: string | null;
  kind: 'execution' | 'preserved' | 'local_append' | 'observed_local' | 'unknown';
};
export type ProjectedRecord = {
  type: 'session_meta' | 'turn_context' | 'token_usage_record' | 'event_msg' | 'session_title';
  timestamp?: string | null;
  payload: Record<string, unknown>;
};
export type ExtractionContext = {
  thread_id: string; turn_id: string | null; cwd: string | null;
  model: string | null; effort: string | null;
  forked_from_id: string | null; subagent_parent_id: string | null;
  source_project_id: string | null;
  /** Optional so immutable extractor-v1 packets remain valid. */
  service_tier_state?: ServiceTierState;
};
export type Observation = {
  observation_id: string; record_revision: number;
  source_id: string; generation: number; locator: number; byte_end: number;
  /** SHA-256 of every original complete line in this source prefix, including unprojected records. */
  prefix_hash: string;
  /** Stable session identity is necessary before prefix equality can identify copied records. */
  session_trusted: boolean;
  origin: OriginEvidence; context: ExtractionContext;
  record: ProjectedRecord | null; issue?: string;
};
export type ThreadChange = {
  id: string; project: string | null; source_project_id: string | null;
  source: string | null; parent_id: string | null;
  subagent_parent_id: string | null; forked_from_id: string | null;
  title?: string | null; title_updated_at?: string | null;
};
export type Candidate = Tokens & {
  observation_id: string; record_revision: number; source_id: string; generation: number;
  event_id: string; thread_id: string; turn_id: string | null; response_id: string | null;
  at: string; project: string | null; source_project_id: string | null;
  model: string | null; effort: string | null; kind: 'record' | 'legacy';
  signature: string | null; incomplete: boolean; excluded: boolean;
  identity_quality: 'response' | 'verified_prefix' | 'source_position';
  origin: OriginEvidence;
  service_tier?: ServiceTier; service_tier_source?: ServiceTierSource;
};
export type CanonicalEvent = Tokens & {
  event_id: string; thread_id: string; turn_id: string | null; response_id: string | null;
  at: string; project: string | null; source_project_id: string | null;
  model: string | null; effort: string | null; kind: 'record' | 'legacy';
  origin_device_id: string | null; incomplete: boolean; identity_quality: Candidate['identity_quality'];
  conflict: boolean; origin_conflict: boolean; selected_observation_id: string;
  service_tier?: ServiceTier; service_tier_source?: ServiceTierSource;
  /** An explicit user choice; natural origin_device_id remains unchanged. */
  user_assignment?: {operation_id:string;device_id:string;label:'用户指定'};
};
export type LegacyState = {
  thread_id: string; high: Partial<Record<TokenField, string>> | null;
  signatures: Record<string, string>; previous: string | null;
  parent_id: string | null; inherited: boolean; cutoff: string | null;
  deferred: boolean; issues: number;
  /** The configuration revision at the preceding cumulative count. */
  service_tier_revision?: number | null;
};
export type DependencyView = {
  /** Parent coverage must be complete at the child's cutoff before declaring an unmatched prefix new. */
  parentStatus: (threadId: string, cutoff: string) => 'missing' | 'partial' | 'complete';
  parentHasSignature: (threadId: string, signature: string, cutoff: string) => boolean;
};
export type ConsumeResult = { state: LegacyState; candidates: Candidate[]; threads: ThreadChange[]; dependencies: string[] };
export type EventDelta = { event_id: string; before: CanonicalEvent | null; after: CanonicalEvent | null };
