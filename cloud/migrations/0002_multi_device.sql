-- Preserve the v1 tables' contents while changing device ownership to one-to-many.
CREATE TABLE devices_next (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, bound_at INTEGER NOT NULL,
  revoked_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, protocol INTEGER NOT NULL DEFAULT 1,
  next_upload_at INTEGER NOT NULL DEFAULT 0, upload_nonce TEXT,
  collected_at TEXT, received_at INTEGER, total_threads INTEGER,
  initial_complete INTEGER NOT NULL DEFAULT 0, sync_error TEXT
);
INSERT INTO devices_next(id,user_id,name,token_hash,bound_at,next_upload_at)
SELECT d.id,d.user_id,d.name,d.token_hash,d.bound_at,u.next_upload_at FROM devices d JOIN users u ON u.id=d.user_id;
DROP TABLE devices;
ALTER TABLE devices_next RENAME TO devices;
CREATE INDEX devices_owner ON devices(user_id,id);
CREATE TABLE quota_next (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,device_id)
);
INSERT INTO quota_next SELECT * FROM quota_snapshots;
DROP TABLE quota_snapshots;
ALTER TABLE quota_next RENAME TO quota_snapshots;
ALTER TABLE users ADD COLUMN account_key TEXT;
ALTER TABLE users ADD COLUMN settings TEXT;
CREATE TABLE usage_revisions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
  parser_version INTEGER NOT NULL, collected_at TEXT NOT NULL, manifest TEXT NOT NULL,
  received_at INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(device_id,dataset_id,thread_id,revision)
);
CREATE TABLE usage_heads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(device_id,dataset_id,thread_id)
);
CREATE TABLE usage_chunks (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL, hash TEXT NOT NULL, event_count INTEGER NOT NULL,
  PRIMARY KEY(device_id,dataset_id,thread_id,revision,chunk_index)
);
CREATE TABLE usage_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL, event_key TEXT NOT NULL,
  turn_id TEXT, response_id TEXT, at TEXT NOT NULL, project TEXT, model TEXT, effort TEXT, kind TEXT NOT NULL,
  incomplete INTEGER NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
  output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
  PRIMARY KEY(device_id,dataset_id,thread_id,revision,event_key)
);
CREATE INDEX usage_records_time ON usage_records(user_id,at,device_id);
CREATE INDEX usage_records_thread ON usage_records(user_id,thread_id,turn_id);
CREATE INDEX usage_heads_owner ON usage_heads(user_id,device_id);
CREATE INDEX usage_revisions_owner ON usage_revisions(user_id,device_id);
CREATE TABLE cloud_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_ref TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, request_hash TEXT,
  PRIMARY KEY(device_id,account_ref)
);
ALTER TABLE devices ADD COLUMN current_account_ref TEXT;
ALTER TABLE devices ADD COLUMN history_deleted_at INTEGER;
