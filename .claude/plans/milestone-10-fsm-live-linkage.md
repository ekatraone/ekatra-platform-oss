# Milestone M10 — FSM → Live Learner State Linkage

**Status**: IN_PROGRESS
**Version**: v2.10.0
**Branch**: milestone/10-fsm-live-linkage
**Started**: 2026-04-12

---

## Objective

Connect the visual FSM editor to the live WhatsApp conversation engine.

Right now: `fsmDefinitions` table exists. FSMEditor visual tool is complete. `conversationFSM.ts` is a **hardcoded engine** that never reads FSM definitions. The two systems are completely isolated.

Target: An admin draws a course flow in FSMEditor → assigns it to a course → enrolled learners are driven by that definition, not the hardcoded engine. The FSMEditor shows live learner positions as overlaid badges on nodes.

---

## The Gap (Archaeology)

| Layer | State |
|---|---|
| `fsm_definitions` DB table | ✅ exists — CRUD API live |
| `courses.fsm_definition_id` FK | ✅ column exists in DB |
| `FSMEditor.tsx` | ✅ visual editor complete (React Flow) |
| `conversationFSM.ts` | ❌ hardcoded — never reads `fsmDefinitions` |
| Enrollment→FSM assignment | ❌ enrollments don't store `fsm_definition_id` |
| FSMEditor live overlay | ❌ no learner position data shown |
| `messageHandler.ts` | ❌ always uses hardcoded engine |

---

## Acceptance Criteria

### Track A: DB + Enrollment linkage (Day 1)
- [ ] `enrollments` table gets `fsm_definition_id UUID NULLABLE REFERENCES fsm_definitions(id)`
- [ ] `db.enrollments.create()` accepts `fsmDefinitionId` and stores it
- [ ] `db.enrollments.update()` fieldMap includes `fsmDefinitionId → fsm_definition_id`
- [ ] `POST /api/learners/:id/enroll` — if the enrolled course has a `fsm_definition_id`, copy it onto the enrollment

### Track B: Dynamic FSM engine (Day 2)
- [ ] `conversationFSM.ts` `process()`: at the **top** of the method, load the learner's active enrollment and check `fsm_definition_id`
- [ ] If `enrollment.fsm_definition_id` is set: read `fsm_json` from `fsmDefinitions`, resolve current node from `learner.metadata.fsm_dynamic.state` (separate namespace — see Architecture), and execute matching transition
- [ ] If `enrollment.fsm_definition_id` is null: fall through to existing `switch(ctx.state)` — zero regression
- [ ] Trigger matching uses the same normalisation as existing `process()`: `input.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/, '').trim()`
- [ ] Node types `lesson`, `question`, `end` map to existing delivery logic (`sendNextLesson`, `runDayEndReview`)
- [ ] Error path: if definition row is missing, JSON is malformed, or no transition matches → log warning and send learner: `"Something went wrong. Reply *menu* to continue."` — do not throw

### Track C: Live overlay in FSMEditor (Day 3)
- [ ] Backend: `GET /api/fsm/:id/learners` — returns `{ stateId: string, count: number, learners: [{ id, phone, name }] }[]` by reading active enrollments with this `fsm_definition_id` and their current `metadata.fsm_dynamic.state`
- [ ] Frontend `apiClient.ts`: add `getFSMLearnerPositions(fsmId: string)`
- [ ] `FSMEditor.tsx`: poll `getFSMLearnerPositions` every 15s when a definition is loaded
- [ ] Each node renders a learner-count badge (e.g. "3 learners") when `count > 0`
- [ ] Clicking the badge opens a popover listing learner names + phone numbers

### Track D: Assignment UI on Course detail (Day 3)
- [ ] `CourseEditor.tsx` (component): add an "FSM Flow" tab/section showing which FSM is assigned
- [ ] Dropdown to select from `GET /api/fsm` list
- [ ] Save calls `api.updateCourse(id, { fsm_definition_id: selectedId })`
- [ ] Badge on CoursesList showing "FSM" if course has an FSM assigned

---

## Architecture Decisions

### FSM Execution Model (Track B)

The dynamic engine activates inside `conversationFSM.process()` — **not** in `messageHandler.ts` (which is a thin 4-line router and needs no changes).

Exact flow:

```typescript
// Top of conversationFSM.process()
const enrollment = await db.enrollments.findActiveByLearner(learner.id);
if (enrollment?.fsm_definition_id) {
  return this.processDynamic(learner, enrollment, normalizedMessage);
}
// else: fall through to existing switch(ctx.state)
```

`processDynamic()` (new private method):
1. Load `fsm_json` from `db.fsmDefinitions.findById(enrollment.fsm_definition_id)`
2. Read current state: `learner.metadata.fsm_dynamic?.state ?? firstStartNode.id`
3. Find matching transition: `t.from === currentState && normalize(t.trigger) === normalizedMessage`
4. On no match: send fallback message `"Something went wrong. Reply *menu* to continue."` and return
5. On malformed JSON or missing definition: same fallback + `logger.error()`
6. Execute target node action by `node.type`:
   - `lesson` → `courseDelivery.sendNextLesson()`
   - `question` → `runDayEndReview()`
   - `end` → mark enrollment complete
7. Update `learner.metadata.fsm_dynamic.state = transition.to` via optimistic lock

### State Namespace Isolation

The hardcoded engine uses `learner.metadata.fsm.state` (values: `idle`, `learning`, etc.).
The dynamic engine uses `learner.metadata.fsm_dynamic.state` (values: FSM node IDs, e.g. `node_lesson_1`).

These are **separate keys in the JSONB metadata blob** — no collision, no migration needed for existing learners. The live overlay query (`GET /api/fsm/:id/learners`) reads `metadata->'fsm_dynamic'->>'state'`.

### Enrollment re-assignment guard

If a learner has an active enrollment on FSM A and is enrolled in a course with FSM B: the application layer **rejects** the new enrollment with `409 Conflict: "Learner has an active FSM enrollment"`. Admin must unenroll first. This prevents silent supersede and data integrity issues. Add this check to `POST /api/learners/:id/enroll`.

### DB Migration

```sql
-- Migration: 006_enrollment_fsm_linkage.sql
ALTER TABLE enrollments 
  ADD COLUMN fsm_definition_id UUID REFERENCES fsm_definitions(id);

CREATE INDEX idx_enrollments_fsm_definition_id ON enrollments(fsm_definition_id);
```

### Learner positions query

```sql
SELECT 
  (metadata->'fsm_dynamic'->>'state') AS state_id,
  COUNT(*) AS learner_count,
  json_agg(json_build_object('id', id, 'phone', phone, 'name', name)) AS learners
FROM learners
WHERE id IN (
  SELECT learner_id FROM enrollments WHERE fsm_definition_id = $1 AND status = 'active'
)
GROUP BY state_id;
```

---

## File Manifest

### Backend
| File | Change |
|---|---|
| `packages/database/src/migrations/006_enrollment_fsm_linkage.sql` | New migration |
| `packages/database/src/index.ts` | Add `fsmDefinitionId` to enrollments create/update; add `findActiveByLearner()` |
| `apps/backend/src/routes/learners.ts` | Copy `fsm_definition_id` from course on enroll; add 409 re-assignment guard |
| `apps/backend/src/routes/fsm.ts` | Add `GET /:id/learners` route |
| `apps/backend/src/flows/conversationFSM.ts` | Add dynamic engine check at top of `process()`; add `processDynamic()` private method |

### Frontend
| File | Change |
|---|---|
| `apps/frontend/src/services/apiClient.ts` | Add `getFSMLearnerPositions(fsmId)` |
| `apps/frontend/src/pages/FSMEditor.tsx` | Live learner overlay (poll + badges + popover) |
| `apps/frontend/src/components/dashboard/CourseEditor.tsx` | FSM assignment section |
| `apps/frontend/src/pages/Courses.tsx` | FSM badge on course list items |

---

## Rollback / Safety

- `fsm_definition_id` is nullable on both `courses` and `enrollments` — existing learners are unaffected
- Dynamic engine only activates when `enrollment.fsm_definition_id IS NOT NULL`
- Hardcoded engine is the zero-change fallback
- All existing pilot learners continue on hardcoded engine unless manually re-enrolled on an FSM-assigned course

---

## Sequencing

```
Day 1: Track A (DB migration + enroll wiring + 409 guard)
Day 2: Track B (dynamic engine — conversationFSM.processDynamic())
Day 3: Track C (live overlay) + Track D (assignment UI) + full end-to-end test
```

End-to-end test:
1. Create a course → assign FSMEditor flow with 3 nodes (start→lesson→end)
2. Enroll test learner via Chat History Enroll CTA
3. Confirm enrollment has `fsm_definition_id` set
4. Send "hi" via Twilio test → confirm FSM drives to `lesson` node → Day 1 sent
5. Open FSMEditor → confirm learner badge shows on `lesson` node

---

## Open Questions for Abheejit

1. **Dual-engine transition**: Existing pilot learners (enrolled without `fsm_definition_id`) stay on hardcoded engine. Re-enroll them manually on the new FSM flow, or leave them on the old flow for the current cohort?
2. **FSM trigger model**: First version uses exact-match text triggers using existing normalisation. Regex/keyword-list triggers deferred to M11.
3. **Enrollment re-assignment**: Plan specifies 409 Conflict (reject). Confirm this is correct — admins must explicitly unenroll before switching a learner's FSM flow.
