CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_upload_at INTEGER NOT NULL DEFAULT 0,
  upload_nonce TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
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
);
CREATE INDEX device_authorizations_expiry ON device_authorizations(expires_at);
CREATE TABLE devices (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  bound_at INTEGER NOT NULL
);
CREATE TABLE quota_snapshots (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
