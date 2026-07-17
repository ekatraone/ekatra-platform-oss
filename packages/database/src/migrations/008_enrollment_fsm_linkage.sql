-- Migration 008: Enrollment FSM Linkage
-- Links enrollments to a specific FSM definition so learners can be driven
-- by the visual flow rather than the hardcoded conversation engine.
-- Nullable — existing enrollments are unaffected and continue on the hardcoded engine.

ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS fsm_definition_id UUID REFERENCES fsm_definitions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_enrollments_fsm_definition_id ON enrollments(fsm_definition_id) WHERE fsm_definition_id IS NOT NULL;
