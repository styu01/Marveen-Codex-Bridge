CREATE TABLE IF NOT EXISTS codex_runtime_threads (
  agent_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE,
  app_server_generation INTEGER NOT NULL,
  model TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  invalidated_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_runtime_runs (
  idempotency_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN (
      'starting', 'running', 'succeeded', 'failed', 'interrupted_unknown'
    )),
  thread_id TEXT,
  turn_id TEXT,
  response TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_codex_runtime_runs_agent
  ON codex_runtime_runs(agent_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_codex_runtime_runs_state
  ON codex_runtime_runs(state, updated_at_ms);
