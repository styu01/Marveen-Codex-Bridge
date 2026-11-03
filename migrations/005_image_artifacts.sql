CREATE TABLE IF NOT EXISTS codex_image_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_relative_path TEXT NOT NULL,
  stored_relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, workspace_relative_path, sha256)
);

CREATE INDEX IF NOT EXISTS idx_codex_image_artifacts_run
  ON codex_image_artifacts(run_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_codex_image_artifacts_agent
  ON codex_image_artifacts(agent_id, created_at_ms);
