-- Migration 009: Course Source
-- Distinguishes AI-generated courses (courseGenerator.ts) from authored/predefined
-- courses ingested from a source document (Milestone 12). Additive, no behavior
-- change for existing rows — everything already in the table defaults to
-- 'ai_generated' and continues through the unmodified lessons-table delivery path.

ALTER TABLE courses ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ai_generated';

CREATE INDEX IF NOT EXISTS idx_courses_source ON courses(source);
