CREATE TABLE v3_entity_versions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  valid_from INTEGER NOT NULL, valid_to INTEGER, revision INTEGER NOT NULL,
  hash TEXT NOT NULL, at TEXT, thread_id TEXT, origin_device_id TEXT,
  payload TEXT, PRIMARY KEY(user_id,epoch,kind,entity_id,valid_from)
);
CREATE UNIQUE INDEX v3_entity_current ON v3_entity_versions(user_id,epoch,kind,entity_id) WHERE valid_to IS NULL;
CREATE INDEX v3_entity_manifest ON v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,valid_to);
CREATE INDEX v3_entity_time ON v3_entity_versions(user_id,epoch,at,valid_from,valid_to);
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
CREATE INDEX v3_read_leases_gc ON v3_read_leases(user_id,epoch,expires_at,cut);
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
CREATE TRIGGER v3_device_authorization_changed
AFTER UPDATE OF paused,revoked_at,history_deleted_at,token_hash ON devices
WHEN NEW.paused IS NOT OLD.paused OR NEW.revoked_at IS NOT OLD.revoked_at
  OR NEW.history_deleted_at IS NOT OLD.history_deleted_at OR NEW.token_hash IS NOT OLD.token_hash
BEGIN
  UPDATE devices SET auth_version=OLD.auth_version+1 WHERE id=NEW.id;
END;
-- Compatibility device deletion also invalidates v3 reads and schedules its facts for removal.
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
