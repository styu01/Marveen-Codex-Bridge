CREATE TABLE IF NOT EXISTS codex_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  app_server_generation INTEGER NOT NULL,
  provider_request_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('command', 'file_change')),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'approved', 'declined', 'expired')),
  decision_json TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  UNIQUE(app_server_generation, provider_request_id)
);

CREATE INDEX IF NOT EXISTS idx_codex_approvals_state
  ON codex_approvals(state, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_codex_approvals_run
  ON codex_approvals(run_id, created_at_ms);

CREATE TABLE IF NOT EXISTS codex_runtime_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  app_server_generation INTEGER NOT NULL
);

INSERT OR IGNORE INTO codex_runtime_meta(singleton, app_server_generation)
VALUES (1, 0);
