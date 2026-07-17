-- Migration 004: Add day_number to lessons table
-- Supports 3-5 day × 3-5 module per day course structure

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS day_number INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN lessons.day_number IS 'Day number within the course (1-5). Modules within same day share day_number and are delivered sequentially.';
