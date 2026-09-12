-- Exact source provenance, supplied by the original uploader before replaying v3 wire.
CREATE TABLE v3_legacy_pending_sources (
  user_id TEXT NOT NULL, collector_id TEXT NOT NULL, source_id TEXT NOT NULL,
  generation INTEGER NOT NULL, dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  PRIMARY KEY(user_id,collector_id,source_id,generation,dataset_id,thread_id),
  FOREIGN KEY(user_id,collector_id) REFERENCES v3_collectors(user_id,collector_id) ON DELETE CASCADE
);
