ALTER TABLE federation_inbox
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);

ALTER TABLE federation_inbox
  ADD COLUMN available_at_ms INTEGER;

ALTER TABLE federation_inbox
  ADD COLUMN lease_owner TEXT;

ALTER TABLE federation_inbox
  ADD COLUMN lease_expires_at_ms INTEGER;

UPDATE federation_inbox
SET available_at_ms = created_at_ms
WHERE available_at_ms IS NULL;

CREATE INDEX IF NOT EXISTS idx_federation_inbox_ready_v2
  ON federation_inbox(state, available_at_ms, inbox_id);

CREATE INDEX IF NOT EXISTS idx_federation_inbox_lease_v2
  ON federation_inbox(state, lease_expires_at_ms);
