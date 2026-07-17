# Changelog — Ekatra Platform

All notable changes grouped by milestone.

---

## [v2.8.0] — 2026-04-07 — M8: FSM Editor + super_admin + Security

### Added
- Visual FSM editor (`/fsm-editor`) — drag-drop React Flow canvas for course flow design
- Node types: `start`, `lesson`, `question`, `end` with color coding
- FSM auto-save (1.5s debounce) on node/edge change
- `fsm_definitions` table (id, org_id, name, version, fsm_json JSONB, created_by, timestamps)
- `courses.fsm_definition_id` nullable FK → fsm_definitions (ON DELETE SET NULL)
- `/api/fsm` CRUD endpoints (GET list, GET by id, POST, PUT, DELETE)
- super_admin role — `POST /api/auth/seed` now accepts `role: 'super_admin'`
- `fsmDefinitionsRepo` in `@ekatra/database` (findAll, findById, create, update, delete)
- `GitBranch` icon + "Flow Editor" sidebar entry (admin+ only)
- `FSMDefinition`, `FSMListItem`, `FSMJson` TypeScript types in apiClient

### Security
- **Fixed IDOR**: Org-scope guard added to `PUT /api/users/:id` and `DELETE /api/users/:id`
- **Replaced `Math.random()`** with `crypto.randomBytes(12)` for temporary password generation
- **Added input validation**: Email regex + name max-255 on `POST/PUT /api/users`
- **fsmJson size cap**: 64KB max on `POST /api/fsm` and `PUT /api/fsm/:id` to prevent blob attacks
- **Cache-Control: no-store** on user creation response to minimize credential caching
- **All FSM mutations** are org-scoped (route-layer check against `req.auth!.organizationId`)

### Fixed
- Login blocked for deployed frontend due to missing `FRONTEND_URL` env var on Railway backend (defaulted to `http://localhost:3000`). Set `FRONTEND_URL=https://ekatra-frontend-production.up.railway.app`.

### Known Issues / Deferred
- FSM→course assignment UI (Course detail dropdown) — DB column exists; no UI/API yet (M9 Day 1)
- `.env` live credentials in git history — requires `git filter-repo` + secrets rotation (Abheejit action)
- `fsm_definitions.organization_id` missing index (M9)
- `fsm_json` stores React Flow render state + FSM logic — schema split deferred to M9

---

## [v2.7.0] — 2026-04-06 — M7: Live UI + Auth + Roles

### Added
- React + Vite frontend deployed on Railway (`ekatra-frontend` service)
- JWT authentication (`POST /api/auth/login`, `POST /api/auth/logout`)
- Role system: `viewer`, `admin`, `super_admin`
- `/api/users` CRUD with `requireRole` middleware
- Dashboard UI: Courses, Learners, Analytics, Messages, Settings pages
- Sidebar navigation filtered by role
- `AuthProvider` + `RequireAuth` / `RequireRole` React components

---

## [v2.6.0] — 2026-04-06 — M6: Bug Hardening

### Fixed
- `sendNextLesson`: null check before lesson lookup
- `handleDoubt`: context variable undefined in FSM doubt handler
- Timeout context: `ctx` passed correctly into timeout callbacks
- FSM retry: off-by-one on retry sequence
- Phone validation: international format normalization (+country code)

---

## [v1.0.0] — Pre-session — M1–M5: WhatsApp Pilot FSM

### Added
- WhatsApp Business API integration (Meta webhook)
- Learner enrollment via WhatsApp (`/start` keyword)
- FSM-driven lesson delivery (sequential, timed)
- PostgreSQL schema: organizations, learners, courses, lessons, enrollments
- Railway backend deployment
