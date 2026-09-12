ALTER TABLE v3_receipts ADD COLUMN applied_at INTEGER;
ALTER TABLE v3_sync_domains ADD COLUMN rebuild_job TEXT;
ALTER TABLE v3_sync_domains ADD COLUMN legacy_baseline_pending INTEGER NOT NULL DEFAULT 0;

-- Private staging rows are never included by a published-epoch read.
CREATE TABLE v3_rebuild_candidates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, observation_id TEXT NOT NULL, event_id TEXT, payload TEXT,
  PRIMARY KEY(user_id,job_id,observation_id)
);
CREATE INDEX v3_rebuild_candidate_events ON v3_rebuild_candidates(user_id,job_id,event_id);
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
CREATE TABLE v3_legacy_heads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  imported_revision INTEGER NOT NULL DEFAULT 0, retired_revision INTEGER NOT NULL DEFAULT 0,
  collector_id TEXT, source_id TEXT,
  PRIMARY KEY(user_id,device_id,dataset_id,thread_id)
);

CREATE TRIGGER v3_queue_existing_legacy AFTER INSERT ON v3_sync_domains
WHEN EXISTS(SELECT 1 FROM usage_heads WHERE user_id=NEW.user_id)
BEGIN
  UPDATE v3_sync_domains SET legacy_baseline_pending=1 WHERE user_id=NEW.user_id;
  INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
  VALUES(NEW.user_id,'legacy-migrate','legacy_migrate','{}',unixepoch()*1000,unixepoch()*1000)
  ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0;
END;
CREATE TRIGGER v3_legacy_head_inserted AFTER INSERT ON usage_heads
BEGIN
  UPDATE v3_sync_domains SET write_version=write_version+1,legacy_baseline_pending=1 WHERE user_id=NEW.user_id;
  INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
  SELECT NEW.user_id,'legacy-migrate','legacy_migrate','{}',unixepoch()*1000,unixepoch()*1000 FROM v3_sync_domains WHERE user_id=NEW.user_id
  ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0,payload='{}',checkpoint='{}' WHERE v3_jobs.state IN('complete','failed','cancelled');
END;
CREATE TRIGGER v3_legacy_head_updated AFTER UPDATE OF revision ON usage_heads
WHEN OLD.revision<>NEW.revision
BEGIN
  UPDATE v3_sync_domains SET write_version=write_version+1,legacy_baseline_pending=1 WHERE user_id=NEW.user_id;
  INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
  SELECT NEW.user_id,'legacy-migrate','legacy_migrate','{}',unixepoch()*1000,unixepoch()*1000 FROM v3_sync_domains WHERE user_id=NEW.user_id
  ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0,payload='{}',checkpoint='{}' WHERE v3_jobs.state IN('complete','failed','cancelled');
END;

-- Also cover users whose v3 domain existed before this additive migration.
UPDATE v3_sync_domains SET legacy_baseline_pending=1 WHERE EXISTS(SELECT 1 FROM usage_heads h WHERE h.user_id=v3_sync_domains.user_id);
INSERT INTO v3_jobs(user_id,job_id,kind,payload,created_at,updated_at)
SELECT user_id,'legacy-migrate','legacy_migrate','{}',unixepoch()*1000,unixepoch()*1000 FROM v3_sync_domains WHERE legacy_baseline_pending=1
ON CONFLICT(user_id,job_id) DO UPDATE SET state='pending',next_attempt_at=0;
