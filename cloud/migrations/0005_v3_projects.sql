-- Source evidence and human choices are independent of replayable usage facts.
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
CREATE INDEX v3_project_sources_device ON v3_project_sources(user_id, device_id);

CREATE TABLE v3_project_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (user_id, collector_id, source_id, generation, source_project_id, thread_id)
);
CREATE INDEX v3_project_sessions_thread ON v3_project_sessions(user_id, thread_id);

CREATE TABLE v3_project_rules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partitions TEXT NOT NULL DEFAULT '[]',
  names TEXT NOT NULL DEFAULT '{}'
);

-- Current rows accelerate graph changes. Snapshot reads use v3_entity_versions only.
CREATE TABLE v3_project_entities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT,
  PRIMARY KEY (user_id, entity_id)
);
