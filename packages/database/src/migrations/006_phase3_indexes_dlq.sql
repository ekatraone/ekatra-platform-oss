-- Migration 006: Phase 3 — Performance indexes + Dead-letter queue
--
-- 1. Composite index on message_log(learner_id, created_at) — fixes slow per-learner
--    history queries which currently do a full table scan on large deployments.
--
-- 2. Index on lesson_progress(status, enrollment_id) — speeds up filtering pending
--    lessons per enrolment (used in executeSchedule hot path).
--
-- 3. failed_messages table — dead-letter queue for WhatsApp messages that failed
--    after all retry attempts. Prevents silent data loss; ops team can inspect and
--    manually retry or investigate.

-- ── Composite index: learner message history ─────────────────────────────
-- Queries like "last 50 messages for learner X ordered by time" use this.
CREATE INDEX IF NOT EXISTS idx_message_log_learner_created
  ON message_log(learner_id, created_at DESC);

-- ── Index: lesson progress by status ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lesson_progress_status
  ON lesson_progress(status, enrollment_id);

-- ── Dead-letter queue table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS failed_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id) ON DELETE SET NULL,
  phone           VARCHAR(30),
  message_type    VARCHAR(50) NOT NULL,   -- 'lesson', 'reminder', 'template', etc.
  payload         JSONB NOT NULL,          -- full message payload for replay
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved        BOOLEAN DEFAULT FALSE,   -- TRUE once manually retried/dismissed
  resolved_at     TIMESTAMP WITH TIME ZONE,
  resolved_by     VARCHAR(100),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_messages_learner
  ON failed_messages(learner_id);
CREATE INDEX IF NOT EXISTS idx_failed_messages_unresolved
  ON failed_messages(resolved, created_at DESC)
  WHERE resolved = FALSE;   -- partial index — only unresolved rows; keeps it small
