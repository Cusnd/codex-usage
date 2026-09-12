-- Current pre-release schema. Initialize an empty database; no historical upgrade path.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  account_key TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  approved_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at INTEGER,
  approval_nonce TEXT
, resumed_device_id TEXT);

CREATE TABLE "devices" (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, bound_at INTEGER NOT NULL,
  revoked_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, protocol INTEGER NOT NULL DEFAULT 3,
  next_upload_at INTEGER NOT NULL DEFAULT 0, upload_nonce TEXT,
  collected_at TEXT, received_at INTEGER, total_threads INTEGER,
  initial_complete INTEGER NOT NULL DEFAULT 0, sync_error TEXT
, current_account_ref TEXT, history_deleted_at INTEGER, auth_version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE cloud_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_ref TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, request_hash TEXT,
  PRIMARY KEY(device_id,account_ref)
);

CREATE TABLE v3_sync_domains (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_epoch TEXT NOT NULL, write_version INTEGER NOT NULL DEFAULT 0,
  commit_seq INTEGER NOT NULL DEFAULT 0, organization_version INTEGER NOT NULL DEFAULT 0,
  deletion_version INTEGER NOT NULL DEFAULT 0, config_version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'ready' CHECK(mode IN ('ready','rebuilding','deleting')),
  changes_floor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
, rebuild_job TEXT);

CREATE TABLE v3_collectors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL, PRIMARY KEY(user_id,collector_id)
);

CREATE TABLE v3_sources (
  user_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, kind TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0, snapshot_eof INTEGER NOT NULL DEFAULT 0,
  context_hash TEXT NOT NULL, context TEXT NOT NULL, parser_state TEXT,
  active INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1, trailing_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,collector_id,source_id,generation),
  FOREIGN KEY(user_id,collector_id) REFERENCES v3_collectors(user_id,collector_id) ON DELETE CASCADE
);

CREATE TABLE v3_candidates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, uploader_device_id TEXT NOT NULL REFERENCES devices(id),
  collector_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL,
  record_revision INTEGER NOT NULL, event_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  turn_id TEXT, at TEXT NOT NULL, signature TEXT, active INTEGER NOT NULL,
  candidate TEXT NOT NULL, origin_claim TEXT, PRIMARY KEY(user_id,observation_id)
);

CREATE TABLE v3_observations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, collector_id TEXT NOT NULL,
  source_id TEXT NOT NULL, generation INTEGER NOT NULL,
  record_revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(user_id,observation_id)
);

CREATE TABLE v3_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, event_id TEXT NOT NULL, revision INTEGER NOT NULL,
  at TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT,
  origin_device_id TEXT, source_project_id TEXT, project TEXT, model TEXT, effort TEXT,
  payload TEXT NOT NULL, PRIMARY KEY(user_id,epoch,event_id)
);

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
  error_code TEXT, applied_at INTEGER, PRIMARY KEY(user_id,batch_id),
  UNIQUE(user_id,collector_id,producer_epoch,lane,lane_seq)
);

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

CREATE TABLE v3_deferred_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, locator INTEGER NOT NULL, observation TEXT NOT NULL,
  PRIMARY KEY(user_id,observation_id)
);

CREATE TABLE v3_entity_versions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  valid_from INTEGER NOT NULL, valid_to INTEGER, revision INTEGER NOT NULL,
  hash TEXT NOT NULL, at TEXT, thread_id TEXT, origin_device_id TEXT,
  payload TEXT, PRIMARY KEY(user_id,epoch,kind,entity_id,valid_from)
);

CREATE TABLE v3_read_leases (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL, epoch TEXT NOT NULL, cut INTEGER NOT NULL,
  deletion_version INTEGER NOT NULL, organization_version INTEGER NOT NULL,
  config_version INTEGER NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('recent','full')),
  from_at TEXT, device_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, max_expires_at INTEGER NOT NULL,
  coverage TEXT NOT NULL DEFAULT '{}', settings TEXT,
  PRIMARY KEY(user_id,lease_id)
);

CREATE TABLE v3_commits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, commit_seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
  entity_count INTEGER NOT NULL, PRIMARY KEY(user_id,epoch,commit_seq)
);

CREATE TABLE v3_changes (
  user_id TEXT NOT NULL, epoch TEXT NOT NULL, commit_seq INTEGER NOT NULL,
  kind TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL,
  hash TEXT NOT NULL, payload TEXT,
  PRIMARY KEY(user_id,epoch,commit_seq,kind,entity_id),
  FOREIGN KEY(user_id,epoch,commit_seq) REFERENCES v3_commits(user_id,epoch,commit_seq) ON DELETE CASCADE
);

CREATE TABLE v3_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
);

CREATE TABLE v3_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL, content_hash TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);

CREATE TABLE v3_project_sources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  local_source_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (user_id, source_project_id),
  UNIQUE (user_id, collector_id, local_source_id)
);

CREATE TABLE v3_project_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (user_id, collector_id, source_id, generation, source_project_id, thread_id)
);

CREATE TABLE v3_project_rules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partitions TEXT NOT NULL DEFAULT '[]',
  names TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE v3_project_entities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT,
  PRIMARY KEY (user_id, entity_id)
);

CREATE TABLE v3_rebuild_candidates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, observation_id TEXT NOT NULL, event_id TEXT, payload TEXT,
  PRIMARY KEY(user_id,job_id,observation_id)
);

CREATE TABLE v3_rebuild_sources (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, payload TEXT,
  PRIMARY KEY(user_id,job_id,collector_id,source_id)
);

CREATE TABLE v3_rebuild_threads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, thread_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(user_id,job_id,collector_id,source_id,generation,thread_id)
);

CREATE TABLE v3_rebuild_origins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, observation_id TEXT NOT NULL, device_id TEXT NOT NULL,
  PRIMARY KEY(user_id,job_id,observation_id)
);

CREATE TABLE v3_origin_operations (
  serial INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN('assign','revoke')), device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','complete','failed')),
  payload TEXT NOT NULL, affected_events INTEGER NOT NULL DEFAULT 0,
  result_cut TEXT, error_code TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(user_id,operation_id)
);

CREATE TABLE v3_origin_operation_events (
  user_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_serial INTEGER NOT NULL,
  event_id TEXT NOT NULL, previous_operation_id TEXT,
  PRIMARY KEY(user_id,operation_id,event_id),
  FOREIGN KEY(user_id,operation_id) REFERENCES v3_origin_operations(user_id,operation_id) ON DELETE CASCADE
);

CREATE TABLE device_sync_versions (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  sync_version TEXT,
  checked_at INTEGER NOT NULL
);

CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE INDEX device_authorizations_expiry ON device_authorizations(expires_at);

CREATE INDEX devices_owner ON devices(user_id,id);

CREATE UNIQUE INDEX v3_sources_active ON v3_sources(user_id,collector_id,source_id) WHERE active=1;

CREATE INDEX v3_candidates_event ON v3_candidates(user_id,event_id,active);

CREATE INDEX v3_candidates_source ON v3_candidates(user_id,collector_id,source_id,generation);

CREATE INDEX v3_candidates_device ON v3_candidates(user_id,uploader_device_id);

CREATE INDEX v3_candidates_thread ON v3_candidates(user_id,thread_id,turn_id,active);

CREATE INDEX v3_observations_source ON v3_observations(user_id,collector_id,source_id,generation);

CREATE INDEX v3_events_time ON v3_events(user_id,epoch,at,event_id);

CREATE INDEX v3_events_origin ON v3_events(user_id,epoch,origin_device_id,at,event_id);

CREATE INDEX v3_events_thread ON v3_events(user_id,epoch,thread_id,at,event_id);

CREATE INDEX v3_receipts_progress ON v3_receipts(user_id,collector_id,producer_epoch,lane,status,lane_seq);

CREATE INDEX v3_jobs_ready ON v3_jobs(state,next_attempt_at,lease_until,created_at);

CREATE UNIQUE INDEX v3_entity_current ON v3_entity_versions(user_id,epoch,kind,entity_id) WHERE valid_to IS NULL;

CREATE INDEX v3_entity_manifest ON v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,valid_to);

CREATE INDEX v3_entity_time ON v3_entity_versions(user_id,epoch,at,valid_from,valid_to);

CREATE INDEX v3_read_leases_gc ON v3_read_leases(user_id,epoch,expires_at,cut);

CREATE INDEX v3_project_sources_device ON v3_project_sources(user_id, device_id);

CREATE INDEX v3_project_sessions_thread ON v3_project_sessions(user_id, thread_id);

CREATE INDEX v3_rebuild_candidate_events ON v3_rebuild_candidates(user_id,job_id,event_id);

CREATE INDEX v3_entity_thread_time ON v3_entity_versions(user_id,epoch,kind,thread_id,at,valid_from,valid_to);

CREATE INDEX v3_origin_event_rules ON v3_origin_operation_events(user_id,event_id,operation_serial DESC);

CREATE INDEX v3_event_effective_origin ON v3_events(user_id,epoch,origin_device_id,event_id);

CREATE TRIGGER v3_device_authorization_changed
AFTER UPDATE OF paused,revoked_at,history_deleted_at,token_hash ON devices
WHEN NEW.paused IS NOT OLD.paused OR NEW.revoked_at IS NOT OLD.revoked_at
  OR NEW.history_deleted_at IS NOT OLD.history_deleted_at OR NEW.token_hash IS NOT OLD.token_hash
BEGIN
  UPDATE devices SET auth_version=OLD.auth_version+1 WHERE id=NEW.id;
END;

CREATE TRIGGER v3_device_history_deleted
AFTER UPDATE OF history_deleted_at ON devices
WHEN NEW.history_deleted_at IS NOT NULL AND NEW.history_deleted_at IS NOT OLD.history_deleted_at
BEGIN
  UPDATE v3_sync_domains SET deletion_version=deletion_version+1,
    write_version=write_version+1,mode='deleting',updated_at=NEW.history_deleted_at
    WHERE user_id=NEW.user_id;
  DELETE FROM v3_read_leases WHERE user_id=NEW.user_id;
  INSERT INTO v3_jobs(user_id,job_id,kind,device_id,payload,created_at,updated_at)
    SELECT NEW.user_id,'delete:'||NEW.id,'delete_device',NEW.id,
      json_object('device_id',NEW.id),NEW.history_deleted_at,NEW.history_deleted_at
    WHERE EXISTS(SELECT 1 FROM v3_sync_domains WHERE user_id=NEW.user_id)
    ON CONFLICT(user_id,job_id) DO NOTHING;
END;

CREATE TRIGGER device_sync_versions_reset AFTER UPDATE OF token_hash ON devices
WHEN NEW.token_hash <> OLD.token_hash
BEGIN
  DELETE FROM device_sync_versions WHERE device_id=NEW.id;
END;
