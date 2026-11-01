-- Durable inbound provider events.
-- The unique provider/event identifier prevents duplicate state transitions while
-- the processing lease allows a crashed handler to be claimed again safely.

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(30) NOT NULL,
  external_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  processing_started_at TIMESTAMP WITH TIME ZONE,
  processed_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  replay_requested_at TIMESTAMP WITH TIME ZONE,
  replay_requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_event_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_recovery
  ON webhook_receipts(status, processing_started_at, received_at)
  WHERE status IN ('received', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_failures
  ON webhook_receipts(updated_at DESC)
  WHERE status = 'failed';
