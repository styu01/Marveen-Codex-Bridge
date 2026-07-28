ALTER TABLE bridge_agents
  ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'
  CHECK (reasoning_effort IN ('medium', 'high', 'xhigh'));

ALTER TABLE codex_threads
  ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'
  CHECK (reasoning_effort IN ('medium', 'high', 'xhigh'));
