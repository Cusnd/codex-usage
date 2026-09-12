-- User choices are a separate, reversible rule ledger, never execution evidence.
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
CREATE INDEX v3_origin_event_rules ON v3_origin_operation_events(user_id,event_id,operation_serial DESC);
CREATE INDEX v3_event_effective_origin ON v3_events(user_id,epoch,origin_device_id,event_id);
