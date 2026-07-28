PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  desired_state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('running', 'stopped', 'draining', 'disabled')),
  actual_state TEXT NOT NULL DEFAULT 'offline'
    CHECK (actual_state IN (
      'offline', 'starting', 'idle', 'busy', 'waiting_approval',
      'auth_required', 'degraded', 'incompatible', 'stopping', 'crashed'
    )),
  model TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_mode TEXT NOT NULL DEFAULT 'directory'
    CHECK (workspace_mode IN ('directory', 'worktree')),
  sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write'
    CHECK (sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')),
  approval_policy TEXT NOT NULL DEFAULT 'bela'
    CHECK (approval_policy IN ('never', 'bela')),
  network_enabled INTEGER NOT NULL DEFAULT 0 CHECK (network_enabled IN (0, 1)),
  instructions TEXT NOT NULL DEFAULT '',
  config_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_threads (
  agent_id TEXT PRIMARY KEY REFERENCES bridge_agents(agent_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  app_server_generation INTEGER NOT NULL,
  model TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resumed_at TEXT,
  invalidated_at TEXT
);

CREATE TABLE IF NOT EXISTS bridge_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES bridge_agents(agent_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'starting', 'running', 'waiting_approval', 'succeeded',
    'failed', 'cancelled', 'interrupting', 'interrupted',
    'interrupted_unknown', 'timed_out'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  thread_id TEXT,
  turn_id TEXT,
  final_response TEXT,
  error_code TEXT,
  error_message TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_bridge_runs_queue
  ON bridge_runs(state, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bridge_runs_agent
  ON bridge_runs(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bridge_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES bridge_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS bridge_outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES bridge_runs(run_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivering', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bridge_outbox_pending
  ON bridge_outbox(state, available_at);

CREATE TABLE IF NOT EXISTS bridge_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES bridge_runs(run_id) ON DELETE CASCADE,
  provider_request_id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'declined', 'expired', 'delivered')),
  decision_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
