-- Hackathon: offline-app sync. Idempotent event ingest + atomic claim of lesson requests.

ALTER TABLE learner_events ADD COLUMN IF NOT EXISTS client_event_id UUID;

-- Deliberately not partial so ON CONFLICT (learner_id, client_event_id) can infer it.
-- NULLs are distinct, so rows written before this migration are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_learner_events_client
  ON learner_events(learner_id, client_event_id);

-- One row per (learner, clientRequestId). Claimed before Muse is called, so a retried
-- request can never start a second generation.
CREATE TABLE IF NOT EXISTS sync_lesson_requests (
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'done', 'failed')),
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (learner_id, client_request_id)
);
