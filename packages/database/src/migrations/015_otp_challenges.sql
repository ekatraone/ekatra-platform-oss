-- WhatsApp sign-in codes sent from our own authentication template (when Twilio Verify is not used).
-- Only a keyed hash of the code is stored. A challenge dies by use, expiry or 5 wrong attempts.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone ON otp_challenges(phone, created_at DESC);
