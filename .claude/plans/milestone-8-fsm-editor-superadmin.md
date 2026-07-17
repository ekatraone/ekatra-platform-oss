# Milestone M8 — FSM Editor + super_admin + Security Hardening

**Status**: IN_PROGRESS
**Version**: v2.8.0
**Branch**: milestone/8-fsm-editor-superadmin
**Started**: 2026-04-06

---

## Objective

Three parallel tracks:
1. **Security hardening** — Close IDOR + secrets issues from M7 audit (blocking)
2. **super_admin seeding** — Create the first super_admin account (breaks M7 catch-22)
3. **Visual FSM Editor** — Drag-drop course flow builder using React Flow, FSM stored in DB

---

## Acceptance Criteria

### Track A: Security (Day 1)
- [ ] Add org-scope check to `PUT /api/users/:id` — user must be in requester's org
- [ ] Add org-scope check to `DELETE /api/users/:id` — user must be in requester's org
- [ ] Replace `Math.random()` with `crypto.randomBytes(12).toString('hex')` for temp passwords
- [ ] Add email format validation regex to POST/PUT /api/users
- [ ] Add `name` max-length 255 guard to POST/PUT /api/users

### Track B: super_admin (Day 1)
- [ ] `POST /api/auth/seed` accepts `role` param (`admin` or `super_admin`) when ADMIN_SEED_KEY present
- [ ] Running seed with `role: super_admin` creates a super_admin user in the org
- [ ] New super_admin can login, see all nav items (including Users, Settings), can delete users

### Track C: FSM Editor (Main Work)
- [ ] DB migration: `fsm_definitions` table (id, organization_id, name, version, fsm_json JSONB, created_by, timestamps)
- [ ] DB migration: `courses` table gets `fsm_definition_id` nullable FK column
- [ ] Backend: `GET /api/fsm` — list FSM definitions for org (admin+)
- [ ] Backend: `POST /api/fsm` — create FSM definition (admin+)
- [ ] Backend: `PUT /api/fsm/:id` — update FSM definition (admin+)
- [ ] Backend: `DELETE /api/fsm/:id` — delete FSM definition (super_admin only)
- [ ] Backend: `GET /api/fsm/:id` — get single definition with full JSON
- [ ] Frontend: `/fsm-editor` route, sidebar nav item (admin+)
- [ ] Frontend: React Flow canvas — nodes = FSM states, edges = transitions
- [ ] Frontend: Node types: `start`, `lesson`, `question`, `end`
- [ ] Frontend: Save FSM JSON → `PUT /api/fsm/:id`
- [ ] Frontend: Load existing FSM → populate React Flow canvas
- [ ] Frontend: Assign FSM to course (dropdown on Course detail page)

---

## Architecture Decisions

### FSM Schema
```sql
-- Migration: 003_fsm_definitions.sql
CREATE TABLE fsm_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  fsm_json JSONB NOT NULL DEFAULT '{"states":[],"transitions":[]}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE courses ADD COLUMN fsm_definition_id UUID REFERENCES fsm_definitions(id);
```

### FSM JSON Shape
```typescript
interface FSMDefinition {
  states: {
    id: string;
    type: 'start' | 'lesson' | 'question' | 'end';
    label: string;
    data?: Record<string, unknown>;  // lesson_id, question_text, etc.
  }[];
  transitions: {
    id: string;
    from: string;     // state id
    to: string;       // state id
    condition?: string;  // 'correct', 'incorrect', 'next', 'timeout'
    label?: string;
  }[];
}
```

### React Flow Integration
- Install: `@xyflow/react` (v12+, replaces reactflow)
- Custom node components per type (lesson node, question node, end node)
- Save triggers debounced PUT (500ms) + manual Save button
- Editor page: two-panel layout (canvas left, node properties panel right)

---

## Files to Change

### Backend
- `apps/backend/src/routes/users.ts` — add org scope to PUT + DELETE; add validation
- `apps/backend/src/routes/auth.ts` — add `role` param to seed endpoint
- `apps/backend/src/routes/fsm.ts` — new file (CRUD FSM definitions)
- `apps/backend/src/index.ts` — register fsmRouter at `/api/fsm`

### Database
- `packages/database/src/migrations/003_fsm_definitions.sql` — new migration
- `packages/database/src/index.ts` — add `fsmDefinitionsRepo` (findAll, findById, create, update, delete)

### Frontend
- `apps/frontend/src/pages/FSMEditor.tsx` — new file (React Flow canvas + save)
- `apps/frontend/src/components/fsm/` — new dir: FSMNode.tsx, FSMEdge.tsx, NodePanel.tsx
- `apps/frontend/src/lib/constants.ts` — add `/fsm-editor` to DASHBOARD_SECTIONS (admin+)
- `apps/frontend/package.json` — add `@xyflow/react`
- `apps/frontend/src/App.tsx` (or router file) — add `/fsm-editor` route

### Migrations
- Run migration against Railway PostgreSQL database

---

## Risks

1. **React Flow bundle size** — adds ~150KB to already-large bundle. Accept for internal tool.
2. **FSM editor → live learner impact** — editing a live FSM mid-cohort will break in-progress learners' state. Add: lock FSM if course has active enrollments, or version-lock FSM per enrollment snapshot.
3. **Migration on live DB** — use `ADD COLUMN ... NULL` (non-destructive) and create table without FK changes to existing running rows.
4. **super_admin seed** — env var `ADMIN_SEED_KEY` must be set on Railway before seeding. Coordinate with Abheejit.

---

## Sequence

1. Fix IDOR security issues (30 min)
2. Add super_admin support to seed endpoint (15 min)
3. Write + run DB migration for fsm_definitions (30 min)
4. Backend FSM CRUD routes (45 min)
5. fsmDefinitionsRepo in database package (20 min)
6. Install React Flow in frontend (5 min)
7. FSMEditor page + custom nodes (2 hr)
8. Wire save/load to API (30 min)
9. Add FSM assignment to Course detail (20 min)
10. Build + deploy frontend + backend (20 min)
