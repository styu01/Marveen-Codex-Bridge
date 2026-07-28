CREATE TABLE IF NOT EXISTS bridge_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES bridge_runs(run_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES bridge_agents(agent_id) ON DELETE CASCADE,
  provider_item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'image'),
  status TEXT NOT NULL CHECK (status = 'ready'),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  file_name TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  workspace_relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  revised_prompt TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, provider_item_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_run
  ON bridge_artifacts(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_agent
  ON bridge_artifacts(agent_id, created_at);
