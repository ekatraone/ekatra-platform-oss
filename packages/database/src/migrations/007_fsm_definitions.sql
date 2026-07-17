-- Migration 007: FSM Definitions
-- Stores visual course flow definitions (state machines) edited in the FSM Editor UI.
-- Each definition belongs to an organization and can be assigned to one or more courses.

CREATE TABLE IF NOT EXISTS fsm_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  fsm_json JSONB NOT NULL DEFAULT '{"states":[],"transitions":[]}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fsm_definitions_org ON fsm_definitions(organization_id);
CREATE INDEX IF NOT EXISTS idx_fsm_definitions_created_by ON fsm_definitions(created_by);

-- Link courses to an FSM definition (nullable — existing courses unaffected)
ALTER TABLE courses ADD COLUMN IF NOT EXISTS fsm_definition_id UUID REFERENCES fsm_definitions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_courses_fsm_definition ON courses(fsm_definition_id) WHERE fsm_definition_id IS NOT NULL;
