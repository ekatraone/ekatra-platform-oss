-- Add response correlation to message_log
-- Links an inbound message to the outbound message it is replying to,
-- and records how long the learner took to respond (in milliseconds).

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS in_reply_to UUID REFERENCES message_log(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS response_time_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_message_log_in_reply_to ON message_log(in_reply_to);
CREATE INDEX IF NOT EXISTS idx_message_log_whatsapp_message_id ON message_log(whatsapp_message_id);
