-- Sign-in abuse ledger, provider-independent (also covers Twilio Verify, which keeps no rows of its
-- own here). kind: 'start' = a code was requested, 'wrong' = a wrong guess, 'lock' = 24h lock began.
CREATE TABLE IF NOT EXISTS otp_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('start', 'wrong', 'lock')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_events_phone ON otp_events(phone, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_events_kind ON otp_events(kind, created_at);
