-- v3 is additive. v2 remains available during migration.
ALTER TABLE devices ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE v3_sync_domains (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_epoch TEXT NOT NULL, write_version INTEGER NOT NULL DEFAULT 0,
  commit_seq INTEGER NOT NULL DEFAULT 0, organization_version INTEGER NOT NULL DEFAULT 0,
  deletion_version INTEGER NOT NULL DEFAULT 0, config_version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'ready' CHECK(mode IN ('ready','rebuilding','deleting')),
  changes_floor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE v3_collectors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL, PRIMARY KEY(user_id,collector_id)
);
CREATE TABLE v3_sources (
  user_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, kind TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0, snapshot_eof INTEGER NOT NULL DEFAULT 0,
  context_hash TEXT NOT NULL, context TEXT NOT NULL, legacy_state TEXT,
  active INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1, trailing_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,collector_id,source_id,generation),
  FOREIGN KEY(user_id,collector_id) REFERENCES v3_collectors(user_id,collector_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX v3_sources_active ON v3_sources(user_id,collector_id,source_id) WHERE active=1;
CREATE TABLE v3_candidates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, uploader_device_id TEXT NOT NULL REFERENCES devices(id),
  collector_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL,
  record_revision INTEGER NOT NULL, event_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  turn_id TEXT, at TEXT NOT NULL, signature TEXT, active INTEGER NOT NULL,
  candidate TEXT NOT NULL, origin_claim TEXT, PRIMARY KEY(user_id,observation_id)
);
CREATE INDEX v3_candidates_event ON v3_candidates(user_id,event_id,active);
CREATE INDEX v3_candidates_source ON v3_candidates(user_id,collector_id,source_id,generation);
CREATE INDEX v3_candidates_device ON v3_candidates(user_id,uploader_device_id);
CREATE INDEX v3_candidates_thread ON v3_candidates(user_id,thread_id,turn_id,active);
CREATE TABLE v3_observations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, collector_id TEXT NOT NULL,
  source_id TEXT NOT NULL, generation INTEGER NOT NULL,
  record_revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(user_id,observation_id)
);
CREATE INDEX v3_observations_source ON v3_observations(user_id,collector_id,source_id,generation);
CREATE TABLE v3_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, event_id TEXT NOT NULL, revision INTEGER NOT NULL,
  at TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT,
  origin_device_id TEXT, source_project_id TEXT, project TEXT, model TEXT, effort TEXT,
  payload TEXT NOT NULL, PRIMARY KEY(user_id,epoch,event_id)
);
CREATE INDEX v3_events_time ON v3_events(user_id,epoch,at,event_id);
CREATE INDEX v3_events_origin ON v3_events(user_id,epoch,origin_device_id,at,event_id);
CREATE INDEX v3_events_thread ON v3_events(user_id,epoch,thread_id,at,event_id);
CREATE TABLE v3_threads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(user_id,thread_id)
);
CREATE TABLE v3_source_threads (
  user_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, thread_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(user_id,collector_id,source_id,generation,thread_id),
  FOREIGN KEY(user_id,collector_id) REFERENCES v3_collectors(user_id,collector_id) ON DELETE CASCADE
);
CREATE TABLE v3_aggregates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, aggregate_key TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(user_id,epoch,aggregate_key)
);
CREATE TABLE v3_aggregate_members (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, aggregate_key TEXT NOT NULL, kind TEXT NOT NULL,
  member_id TEXT NOT NULL, refs INTEGER NOT NULL CHECK(refs>0),
  PRIMARY KEY(user_id,epoch,aggregate_key,kind,member_id)
);
CREATE TABLE v3_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
  collector_id TEXT NOT NULL, producer_epoch TEXT NOT NULL, lane TEXT NOT NULL,
  lane_seq INTEGER NOT NULL, wire_hash TEXT NOT NULL, records_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received','applied','cancelled','failed')),
  received_at INTEGER NOT NULL, applied_epoch TEXT, applied_commit_seq INTEGER,
  error_code TEXT, PRIMARY KEY(user_id,batch_id),
  UNIQUE(user_id,collector_id,producer_epoch,lane,lane_seq)
);
CREATE INDEX v3_receipts_progress ON v3_receipts(user_id,collector_id,producer_epoch,lane,status,lane_seq);
CREATE TABLE v3_producer_progress (
  user_id TEXT NOT NULL, collector_id TEXT NOT NULL, producer_epoch TEXT NOT NULL,
  lane TEXT NOT NULL, received_seq INTEGER NOT NULL DEFAULT 0, applied_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,collector_id,producer_epoch,lane),
  FOREIGN KEY(user_id,collector_id) REFERENCES v3_collectors(user_id,collector_id) ON DELETE CASCADE
);
CREATE TABLE v3_apply_guards (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL, ok INTEGER NOT NULL CHECK(ok=1),
  PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE v3_pending_inputs (
  user_id TEXT NOT NULL, batch_id TEXT NOT NULL, wire BLOB NOT NULL,
  PRIMARY KEY(user_id,batch_id),
  FOREIGN KEY(user_id,batch_id) REFERENCES v3_receipts(user_id,batch_id) ON DELETE CASCADE
);
CREATE TABLE v3_jobs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, kind TEXT NOT NULL, device_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed','cancelled')),
  payload TEXT NOT NULL, checkpoint TEXT NOT NULL DEFAULT '{}',
  lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,job_id)
);
CREATE INDEX v3_jobs_ready ON v3_jobs(state,next_attempt_at,lease_until,created_at);
CREATE TABLE v3_rebuild_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL, payload TEXT,
  PRIMARY KEY(user_id,job_id,kind,entity_id)
);
CREATE TABLE v3_dependencies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL,
  parent_thread_id TEXT NOT NULL, initial_state TEXT,
  PRIMARY KEY(user_id,collector_id,source_id,generation,parent_thread_id)
);
-- Only unresolved dependencies retain the necessary projection, and are reclaimed on resolution.
CREATE TABLE v3_deferred_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, locator INTEGER NOT NULL, observation TEXT NOT NULL,
  PRIMARY KEY(user_id,observation_id)
);
