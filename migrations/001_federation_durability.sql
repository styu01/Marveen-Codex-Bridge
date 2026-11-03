CREATE TABLE IF NOT EXISTS federation_inbox (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id TEXT NOT NULL,
  peer_ref TEXT,
  payload_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted'
    CHECK (state IN ('accepted', 'dispatched', 'completed', 'failed')),
  run_id TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE(peer_id, peer_ref)
);

CREATE INDEX IF NOT EXISTS idx_federation_inbox_state
  ON federation_inbox(state, inbox_id);

CREATE TABLE IF NOT EXISTS federation_outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  peer_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  last_error TEXT,
  last_http_status INTEGER,
  remote_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  dead_at_ms INTEGER,
  CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    OR
    (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
  ),
  UNIQUE(peer_id, message_key)
);

CREATE INDEX IF NOT EXISTS idx_federation_outbox_ready
  ON federation_outbox(state, available_at_ms, outbox_id);

CREATE INDEX IF NOT EXISTS idx_federation_outbox_lease
  ON federation_outbox(state, lease_expires_at_ms);

CREATE TABLE IF NOT EXISTS federation_delivery_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL
    REFERENCES federation_outbox(outbox_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'enqueued', 'claimed', 'lease_recovered', 'retry_scheduled',
      'delivered', 'dead'
    )),
  attempt INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_federation_delivery_events_outbox
  ON federation_delivery_events(outbox_id, event_id);
