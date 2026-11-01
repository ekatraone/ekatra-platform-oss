-- Milestone 13a: structured learning-event capture + derived learner profile.
-- Events are written at answer/advance time (never reconstructed from message text).
-- attempt_n and latency are derived at read time from event ordering, not stored.

CREATE TABLE IF NOT EXISTS learner_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  node_id VARCHAR(255),
  type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learner_events_learner
  ON learner_events(learner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_learner_events_type
  ON learner_events(type);

ALTER TABLE learners ADD COLUMN IF NOT EXISTS profile JSONB;
