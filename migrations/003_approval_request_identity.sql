ALTER TABLE bridge_approvals RENAME TO bridge_approvals_legacy;

CREATE TABLE bridge_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES bridge_runs(run_id) ON DELETE CASCADE,
  app_server_generation INTEGER NOT NULL DEFAULT 0,
  provider_request_id TEXT NOT NULL,
  category TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'declined', 'expired', 'delivered')),
  decision_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

INSERT INTO bridge_approvals(
  approval_id, run_id, app_server_generation, provider_request_id, category,
  request_json, state, decision_json, expires_at, created_at, decided_at
)
SELECT
  approval_id, run_id, 0, provider_request_id, category,
  request_json, state, decision_json, expires_at, created_at, decided_at
FROM bridge_approvals_legacy;

DROP TABLE bridge_approvals_legacy;

CREATE INDEX idx_bridge_approvals_provider_request
  ON bridge_approvals(app_server_generation, provider_request_id);

CREATE INDEX idx_bridge_approvals_pending
  ON bridge_approvals(state, created_at);
