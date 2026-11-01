-- Fencing for lesson-request claims: each (re-)claim bumps `attempt`, and only the run
-- holding the current attempt may mark the request done/failed or enroll the learner.
ALTER TABLE sync_lesson_requests ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
