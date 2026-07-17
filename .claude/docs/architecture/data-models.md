# Data Models — Ekatra Platform

*Last updated: 2026-04-07 (M8)*

---

## organizations
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | VARCHAR(255) | |
| slug | VARCHAR(255) UNIQUE | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## users
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| organization_id | UUID FK → organizations | |
| email | VARCHAR(255) UNIQUE | |
| password_hash | TEXT | bcrypt |
| name | VARCHAR(255) | |
| role | VARCHAR(50) | `viewer` / `admin` / `super_admin` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

Role hierarchy (ascending): `viewer (0) < admin (1) < super_admin (2)`

---

## courses
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| organization_id | UUID FK → organizations | |
| title | VARCHAR(255) | |
| description | TEXT | nullable |
| category | VARCHAR(100) | nullable |
| status | VARCHAR(50) | `draft` / `published` |
| settings | JSONB | default `{}` |
| fsm_definition_id | UUID FK → fsm_definitions | nullable, ON DELETE SET NULL (added M8) |
| created_by | UUID FK → users | nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## fsm_definitions *(added M8)*
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | gen_random_uuid() |
| organization_id | UUID FK → organizations | ON DELETE CASCADE |
| name | VARCHAR(255) | |
| version | INTEGER | default 1, incremented on every UPDATE |
| fsm_json | JSONB | React Flow canvas state (nodes + edges). Default `{"states":[],"transitions":[]}` |
| created_by | UUID FK → users | nullable, ON DELETE SET NULL |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Pending**: Missing index on `organization_id` (planned M9). `fsm_json` stores both semantic FSM logic and render layout — planned split into `logic_json` + `layout_json` before table has production data.

### fsm_json shape
```json
{
  "nodes": [
    { "id": "start", "type": "start", "data": { "label": "Start" }, "position": { "x": 100, "y": 100 } },
    { "id": "l1", "type": "lesson", "data": { "label": "Lesson 1" }, "position": { "x": 300, "y": 100 } },
    { "id": "end", "type": "end", "data": { "label": "End" }, "position": { "x": 500, "y": 100 } }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "l1" },
    { "id": "e2", "source": "l1", "target": "end" }
  ]
}
```

Node types: `start` (green `#22c55e`), `lesson` (blue `#3b82f6`), `question` (amber `#f59e0b`), `end` (red `#ef4444`)

---

## lessons
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| course_id | UUID FK → courses | ON DELETE CASCADE |
| title | VARCHAR(255) | |
| content | TEXT | nullable |
| content_type | VARCHAR(50) | `text` / `video` / `quiz` |
| media_url | TEXT | nullable |
| sequence_order | INTEGER | |
| duration_minutes | INTEGER | default 5 |
| metadata | JSONB | default `{}` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## learners
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| organization_id | UUID FK → organizations | |
| phone | VARCHAR(50) UNIQUE per org | WhatsApp phone |
| name | VARCHAR(255) | nullable |
| email | VARCHAR(255) | nullable |
| whatsapp_id | VARCHAR(255) | nullable |
| status | VARCHAR(50) | `active` / `paused` / `inactive` |
| timezone | VARCHAR(100) | default `UTC` |
| language | VARCHAR(10) | default `en` |
| metadata | JSONB | includes `fsm` key for learner FSM state |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### learner.metadata.fsm shape
```json
{
  "state": "lesson_2",
  "data": { "currentLesson": 2 },
  "version": 3
}
```
`version` is used for optimistic locking in `learnersRepo.updateFSM()`.

---

## enrollments
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| learner_id | UUID FK → learners | |
| course_id | UUID FK → courses | |
| status | VARCHAR(50) | `enrolled` / `in_progress` / `completed` / `dropped` |
| progress | INTEGER | 0–100 |
| current_lesson_id | UUID FK → lessons | nullable |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## schedules
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| course_id | UUID FK → courses | |
| name | VARCHAR(255) | |
| schedule_type | VARCHAR(50) | `daily` / `weekly` |
| days_of_week | INTEGER[] | e.g. `[1,2,3,4,5]` |
| send_time | TIME | e.g. `09:00` |
| timezone | VARCHAR(100) | |
| is_active | BOOLEAN | default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## message_log
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| learner_id | UUID FK → learners | nullable |
| direction | VARCHAR(10) | `inbound` / `outbound` |
| message_type | VARCHAR(50) | `text` / `image` / `template` |
| content | TEXT | nullable |
| media_url | TEXT | nullable |
| whatsapp_message_id | VARCHAR(255) | nullable |
| status | VARCHAR(50) | `sent` / `delivered` / `read` / `failed` |
| metadata | JSONB | delivery timestamps, error codes |
| in_reply_to | VARCHAR(255) | nullable |
| response_time_ms | INTEGER | nullable |
| created_at | TIMESTAMPTZ | |

---

## Pending Schema Changes (M9)
1. `CREATE INDEX idx_fsm_defs_org ON fsm_definitions(organization_id);`
2. Split `fsm_definitions.fsm_json` into `logic_json JSONB` + `layout_json JSONB`
3. `findAll` for fsm_definitions: project only `id, name, version, updated_at` (exclude fsm_json from list)
