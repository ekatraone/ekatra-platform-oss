# Audit Trail — Ekatra Platform

---

## Frontend–Backend Endpoint Parity Audit — 2026-04-12

**Trigger:** `/mr-fox-plan` — full surface audit requested before pilot E2E run.

### Matched (healthy) — 42 routes ✅
All core product surfaces confirmed wired: courses CRUD, learners CRUD + enroll/progress/messages, schedules CRUD + pause/resume/trigger/logs, users CRUD, analytics/stats, health endpoints, FSM editor, auth, webhooks, certificates.

### Fixed in this session:

| # | Issue | Fix Applied |
|---|-------|-------------|
| 1 | `GET /courses/stats` — missing `/api` prefix in `useCourseStats.ts` | Fixed path to `/api/courses/stats` |
| 2 | `GET /api/users/:id` — registered in frontend `apiClient` but route missing on backend | Added `GET /:id` handler to `apps/backend/src/routes/users.ts` |
| 3 | **Static admin panel missing** — `/api/admin/*` (state, reset, send, simulate) had no UI; curl-only | Built `apps/backend/public/admin.html`; wired `express.static` at `/admin` in `index.ts`; added `COPY public` to Dockerfile |

### Orphaned (dead code, no active impact):

| Item | Status |
|------|--------|
| `addModule / updateModule / deleteModule` in apiClient — calls `/days/:n/modules/*` which backend doesn't implement | Dead code — not called from any component. Backend uses `/lessons` schema. Acceptable: leave until Course Editor UI is built. |
| `POST /ai/tutor` in `useAITutor.ts` | 404 on call. Not surfaced in any page. Leave as stub. |
| `/api/courses/generate`, `/api/courses/:id/lessons` CRUD, `/api/learners/stats/overview`, `/api/schedules/:id/execute` | Backend-only utility routes — intentionally unexposed in UI. |
| `/api/certificates/:learnerId` | Registered, public, working. No frontend page links to it — acceptable for pilot phase. |

### CTO Consolidated — Frontend–Backend Parity
**Date**: 2026-04-12
**Mr Fox's Call**: PROCEED
**Executive Summary**: 42 of 48 frontend routes are correctly matched to backend handlers. Two live bugs fixed (Analytics `/courses/stats` was silently 404-ing; `GET /api/users/:id` was unregistered). The static admin panel is now in place — `/admin` serves a login-gated HTML tool covering simulate, state-read, reset, and send, which unblocks pilot E2E testing without curl. Three dead-code items in apiClient are noted but non-blocking.
**From Priya (Security)**: APPROVED — static admin panel is login-gated (JWT) and uses `confirm()` guard on destructive reset action; no bare credential exposure.
**From Kavitha (PM)**: ON_TRACK — simulate and reset panel directly enables the pilot E2E test run from M9 action items.
**From Rajan (Architecture)**: APPROVED — `express.static` at `/admin` with same-origin API calls is the correct pattern; no CORS issues.
**From Meera (Strategy)**: ALIGNED — admin tooling removes a friction point for internal test runs.
**From Arjun (Engineering)**: APPROVED — two bugs fixed cleanly; orphaned dead code documented, not deleted.
**From Divya (Design)**: APPROVED — admin panel is functional, minimal, dark-themed to match product aesthetic.
**From Sanjay (DevOps)**: APPROVED — Dockerfile updated to COPY public/ into production image; Railway deploy will include admin panel.
**Blocking Issues**: None.
**Action Items**:
- [ ] Deploy to Railway and verify `/admin/admin.html` loads in production.
- [ ] Run pilot E2E test using admin panel simulate endpoint (M9 action item #4).
- [ ] Later: align `addModule/updateModule/deleteModule` in apiClient to `/lessons` schema when Course Editor UI is built.
- [ ] Later: surface `/api/certificates/:learnerId` as a link in learner progress page.
**Mr Fox's Note to Abheejit**: The static admin panel was the missing bridge between your backend pilot tooling and an actual human workflow. 42/48 routes healthy. Two silent bugs fixed. You can now do your full E2E pilot run from a browser at `/admin` — no curl required.

---

## M7 Audit — 2026-04-06

### Security Audit — Priya
**Status**: FAIL

**Critical**:
- **IDOR (A01)**: `PUT /api/users/:id` and `DELETE /api/users/:id` — no org scope check. Admin from Org A can mutate users in Org B.
- **Secrets in repo (A02)**: `.env` contains live DB password, Meta WhatsApp token in git history. **Rotate immediately.**
- **Weak crypto (A02)**: `Math.random()` for temp password generation. ~36-bit entropy. Use `crypto.randomBytes`.
- **XSS / JWT storage (A07)**: JWT in `localStorage`. Acknowledged limitation. Upgrade to HttpOnly cookie for production.

**Warnings**:
- No email format validation before DB insert
- No `name` field max-length enforcement
- Temp password returned in response body (should go to email only)
- No token rotation (7-day JWT, no refresh)
- Rate limit gap on GET /api/users (5000 records/request possible)

---

### PM Audit — Kavitha
**Status**: DRIFTED (all criteria met, sequential dependency uncovered)

**Scorcard**: 11/12 criteria PASS (build not verified live, acceptable)

**Key Finding**: Catch-22 on super_admin — no super_admin can be created (no seeding path exists yet). DELETE /api/users requires super_admin. M8 dependency confirmed, intentional deferral.

**Risks to M8**:
1. No test coverage anywhere — first regression will be caught by a pilot user
2. Super_admin seeding must be first task of M8
3. FSM DB schema not designed — blocks visual editor build until schema decided

---

### Architecture Audit — Rajan
**Status**: ACCEPTABLE → CLEAN after M8 schema work

**Highlights**:
- Module boundaries clean (database / backend / frontend)
- requireRole() middleware correctly layered
- VITE_API_URL baked into image at build time (acceptable, not a blocker)
- Role hierarchy: implicit string comparison works for 3 roles, fragile if roles expand
- Learner FSM state in `learner.metadata.fsm` (loose JSON) — fine for pilot

**M8 Schema Gap**:
```sql
CREATE TABLE fsm_definitions (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name VARCHAR(255),
  version INTEGER,
  fsm_json JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
-- courses table: add fsm_definition_id UUID REFERENCES fsm_definitions(id)
```

**Rating**: ACCEPTABLE. Build M8 against this schema spec.

---

### Strategy Audit — Meera
**Status**: PROCEED WITH CAUTION

**Narrative shift**: M7 gives Ekatra a *demandable pilot-ready admin console*. Strong for grants, neutral for angels.

**Role model concern**: viewer/admin/super_admin conflates hierarchy with function. Orgs need: Course Manager, Instructor, Org Admin. Defer to M9 — not M8 scope.

**FSM Editor risk**: Risk of builder's trap. The visual editor is high-effort, low-immediate-value unless pilot partners have expressed pain around course creation. Validate this assumption before over-building.

**Highest leverage next action**: Not code — get one real NGO/school to run a real pilot cohort (even 15 learners). The completion rate metric (65% claimed vs 5-15% industry) is the entire fundraising story. Build data, not features.

---

### CTO Consolidated — Milestone M7
**Date**: 2026-04-06
**Mr Fox's Call**: FIX_REQUIRED (2 items) then PROCEED

**Executive Summary**: M7 shipped cleanly — live frontend, real auth, role system, deployed on Railway, smoke-tested. Stage 1 & 2 complete. Two production-blocking security issues must be addressed before any external pilot partner access: IDOR on user mutations, and .env secrets in git history.

**From Priya (Security)**: FAIL — IDOR + secrets-in-repo critical; 7 warnings
**From Kavitha (PM)**: DRIFTED — all criteria met; super_admin catch-22 noted; no tests
**From Rajan (Architecture)**: ACCEPTABLE — clean boundaries; M8 needs fsm_definitions schema before coding starts
**From Meera (Strategy)**: PROCEED WITH CAUTION — good for grant demo; validate pilot need for FSM editor before over-building

**Blocking Issues**:
- [ ] Fix IDOR: add org scope check to PUT and DELETE /api/users/:id
- [ ] Rotate .env secrets (DB password, Meta token) + git history scrub

**Action Items** (prioritized):
1. [ ] **IMMEDIATE** — `git filter-branch` to remove .env from history; rotate DB password + Meta token
2. [ ] **M8 Day 1** — Add org-scope guard to `PUT` and `DELETE /api/users/:id`
3. [ ] **M8 Day 1** — Replace `Math.random()` with `crypto.randomBytes` for temp passwords
4. [ ] **M8 Day 1** — super_admin seeding endpoint (`POST /api/auth/seed` with `role` param)
5. [ ] **M8 Day 1** — Create `fsm_definitions` migration (schema above)
6. [ ] **M8 Week** — Visual FSM editor (React Flow) — only after validating pilot partner needs it
7. [ ] **M8 Week** — Add email validation + name length guard to `/api/users` POST/PUT
8. [ ] **Parallel (out-of-band)** — Activate 1 real NGO pilot cohort (15+ learners)

**Mr Fox's Note to Abheejit**: Two security issues need 30 minutes of your time today — the .env rotation especially. Everything else is M8 work, and M8 starts strong. The biggest risk isn't code, it's not having real pilot data against which to measure anything you build. Get someone using it.

---

## M8 Audit — 2026-04-07

### Security Audit — Milestone 8
**Auditor**: Priya (Principal AppSec, 16yr)
**Status**: FAIL
**Attack Surface Changes**: New seed endpoint accepting role escalation param; 5 FSM CRUD endpoints accepting arbitrary JSONB blobs; React Flow editor rendering server-controlled graph data; temporaryPassword still in POST response body.
**Files Reviewed**: 11
**Critical**:
- `.env` (git history) — Live DB credentials + Meta WhatsApp token remain in git history. Unchanged from M7. Run `git filter-repo --path .env --invert-paths`, force-push, rotate both secrets.
- `apps/backend/src/routes/users.ts:93` — `temporaryPassword` returned in POST response body (partially mitigated: `Cache-Control: no-store` added this session). Full remediation: out-of-band email delivery. *(Severity downgraded to WARN after Cache-Control fix.)*
**Warnings**:
- `apps/backend/src/routes/auth.ts` — Seed endpoint accepts `role: 'super_admin'` from anyone with `ADMIN_SEED_KEY`. If .env leaked (unfixed), silent super_admin creation is possible. Fix: separate `SUPER_ADMIN_SEED_KEY` or restrict to `role: 'admin'` only.
- `packages/database/src/index.ts:fsmDefinitionsRepo.findById` — No `organization_id` filter in SQL. Org isolation relies solely on route-layer check. Defense-in-depth: add `AND organization_id = $2` and pass orgId from routes.
- `apps/backend/src/routes/fsm.ts` — fsmJson size check added this session (64KB cap). ✅
**Dependency Risk**: `@xyflow/react` — no active CVEs; confirm custom node renderers don't use `dangerouslySetInnerHTML`.
**Data Flow Gaps**: fsmJson travels admin-input → POST → Postgres JSONB → GET → React Flow with no semantic validation. Corrupt payload stored silently crashes editor for org. Size cap added; schema validation still absent.
**Fix Instructions**:
1. **Abheejit action** — `git filter-repo --path .env --invert-paths && git push --force`. Rotate Neon DB password + Meta token.
2. **Next milestone** — `fsmDefinitionsRepo.findById(id, orgId)` SQL: add `AND organization_id = $2`.
3. **M9** — Email delivery for temporary passwords; remove from response body entirely.

---

### PM Audit — Milestone 8
**Auditor**: Kavitha (Sr. TPM, 14yr)
**Status**: DRIFTED
**Criteria Scorecard**:
  - Org-scope PUT /api/users/:id: PASS — implemented, code-reviewed
  - Org-scope DELETE /api/users/:id: PASS — implemented
  - crypto.randomBytes for temp passwords: PASS — Math.random() replaced
  - Email format validation POST/PUT /api/users: PASS — regex guard in place
  - Name max-length 255: PASS — validated at API boundary
  - Seed accepts role param: PASS — confirmed in code
  - Seed with super_admin creates super_admin: PASS
  - super_admin login + full nav + delete users: PASS — login confirmed post-deploy
  - DB migration: fsm_definitions table: PASS — live on Neon
  - DB migration: courses.fsm_definition_id FK: PASS — column added
  - GET /api/fsm: PASS
  - POST /api/fsm: PASS
  - PUT /api/fsm/:id: PASS
  - DELETE /api/fsm/:id: PASS — super_admin guard confirmed
  - GET /api/fsm/:id: PASS
  - /fsm-editor route + sidebar nav: PASS — admin+ visible
  - React Flow canvas (nodes/edges): PASS
  - Node types (start/lesson/question/end): PASS
  - Save FSM JSON → PUT: PASS — auto-save wired
  - Load existing FSM → canvas: PASS
  - **Assign FSM to course dropdown: FAIL — not built; DB FK exists, no UI/API wiring**
**Scope Creep**: Auto-save debounce (~30min benign); CORS FRONTEND_URL fix (~20min necessary); fsmJson size cap + Cache-Control fixes this session (~15min).
**Missed Deliverables**: FSM→course assignment. DB FK ready; no PATCH /api/courses/:id nor Course detail dropdown. Blocks FSM-driven delivery in M9.
**Technical Debt Introduced**: Zero automated tests (HIGH, pre-existing); branch not merged to main.
**Demo/Report Readiness**: Editor impresses in demo. Cannot assign to a course — funder asking "can I wire this to a lesson?" hits a dead end. Fix this one item.
**Recommendations**: 1) FSM→course assignment (M9 Day 1); 2) Merge to main; 3) One integration test per security endpoint.
**Next Session Should Start With**: `PATCH /api/courses/:id` + `fsm_definition_id` dropdown on Course detail page, then merge milestone/8 to main.

---

### Architecture Audit — Milestone 8
**Auditor**: Rajan (Distinguished Eng, 18yr)
**Status**: REVIEW_NEEDED
**System Context**: NGO pilot, 10–50 concurrent users, Neon PostgreSQL w/ connection pooling, Railway. Correctness > scale.
**Structural Assessment**:
  - Module boundaries: Clean. fsmDefinitionsRepo follows repo pattern. Concern: `fsm_json JSONB` stores React Flow render state (x/y, styles) alongside FSM logic — DB has implicit dependency on frontend library wire format.
  - Data model: Partially concerning. Storing unified React Flow state conflates rendering state with behavioral state. `version` counter with no optimistic locking gives false sense of conflict safety.
  - API surface: Stable. Parameterized SQL, authMiddleware + role gates, org-scoped mutation checks applied correctly.
  - Error handling: Partial. Auto-save debounce has no error feedback in UI — silent save failures lose user work.
**Pattern Consistency**: Follows repo conventions (pool.query, RETURNING *, role middleware chain).
**Scalability Horizon**: Holds to ~1000 users. Large fsm_json blobs (50+ nodes) increase at complex designs but acceptable at pilot scale.
**Performance Concerns**:
  - Missing index on `fsm_definitions.organization_id` — `findAll` does full table scan. Add: `CREATE INDEX idx_fsm_defs_org ON fsm_definitions(organization_id)`.
  - `SELECT *` in `findAll` returns full fsm_json blobs for list; project only `id, name, version, updated_at`.
**Tech Debt vs Intentional Simplicity**:
  - Smart: last-write-wins acceptable for single-admin NGO pilot.
  - Dangerous: `fsm_json` coupling to React Flow. Consider splitting into `logic_json` + `layout_json` before table has production data.
**Recommendations** (by impact): 1) Split fsm_json schema now (zero migration cost while empty); 2) Index on org_id; 3) Save-failure toast in FSMEditor; 4) Narrow findAll projection.

---

### Strategic Audit — Milestone 8
**Auditor**: Meera (Venture Partner, 2x Founder, 20yr)
**Status**: DISCUSS
**Project Context Discovered**: Pre-revenue MVP. Live on Railway. Solo founder. Zero pilot learners. WhatsApp-first EdTech targeting NGOs/schools in India/Africa. Grant/impact investor pipeline likely.
**Venture Impact**: Unblocked admin layer (CORS fix critical — system was unusable for admins). Visual FSM editor = strong live demo asset for grant reviewers showing non-technical course authoring. Security hardening = table stakes for institutional partners.
**Strategic Leverage**: medium
  - CORS fix was necessary (system was broken). FSM editor is a demo bet. Leverage only realized when a real pilot runs against it.
**Cross-Project Reuse**: Siloed. React Flow FSM + super_admin tightly coupled to this schema and WhatsApp delivery model.
**Fundability Assessment**:
  - Active pipeline relevance: FSM editor makes a memorable live demo for USAID/Gates-adjacent grant reviewers — "a field NGO worker can design a course flow."
  - Investor/funder narrative: Marginally strengthened. Gap remains: 0 learners have completed a course. Funders want traction data, not tooling.
**Sustainability Check**: Risky. FSM editor adds non-trivial maintenance surface for solo founder. FSM→course linkage deferred = editor is currently an island.
**Builder's Trap Warning**: YES. M8 built tooling for an admin who doesn't exist yet. Stop. Next sprint must end with real humans completing lessons via WhatsApp — not more UI.
**Founder Decision Needed**: Hard-freeze on new features after FSM→course assignment. Next 2 weeks = find one NGO/school, enroll 15 learners, run TC1–TC3. No new feature until pilot data exists.
**Recommendations**: Ship the pilot. One NGO contact + 15 learners + completion rate data unlocks every funder conversation better than any further tooling.

---

### CTO Consolidated — Milestone M8
**Date**: 2026-04-07
**Mr Fox's Call**: FIX_REQUIRED (2 items before merge, 1 Abheejit action)

**Executive Summary**: M8 shipped 20/21 acceptance criteria: security hardening, super_admin seeding, visual FSM editor with React Flow, live CORS fix. One criterion missed (FSM→course assignment UI) — deferred to M9 Day 1. Three security items addressed this session (fsmJson size cap, Cache-Control header, org-scope on mutations). .env git history scrub remains Abheejit's action.

**From Priya (Security)**: FAIL → residual .env history + temp password in response body. Mitigated this session (Cache-Control + size cap). Non-blocking for internal pilot but blocking for external partners.
**From Kavitha (PM)**: DRIFTED — 20/21 criteria met. FSM→course assignment missing. Deferred to M9 Day 1.
**From Rajan (Architecture)**: REVIEW_NEEDED — fsm_json schema couples DB to React Flow; missing org_id index; silent save failures. Not blocking for pilot.
**From Meera (Strategy)**: DISCUSS — Builder's Trap alert. Pilot must come before any more features.

**Blocking Issues**:
- [ ] **Abheejit** — Rotate .env secrets (Neon DB password + Meta token) + git history scrub
- [ ] **M9 Day 1** — FSM→course assignment: `PATCH /api/courses/:id` + Course detail dropdown
- [ ] **M9 Day 1** — Merge `milestone/8-fsm-editor-superadmin` → `main`

**Action Items** (prioritized):
1. [ ] **IMMEDIATE (Abheejit)** — `git filter-repo --path .env --invert-paths && git push --force`. Rotate Neon + Meta credentials.
2. [ ] **M9 Day 1** — `PATCH /api/courses/:id` accepts `fsm_definition_id` (null or UUID from org's fsm_definitions)
3. [ ] **M9 Day 1** — Course detail page: FSM dropdown (lists org's flow definitions, allows assign/unassign)
4. [ ] **M9 Day 1** — Merge milestone/8 → main, tag v2.8.0
5. [ ] **M9** — DB: add index on `fsm_definitions.organization_id`; narrow `findAll` projection
6. [ ] **M9** — FSMEditor: save-failure toast (silent data loss is a pilot-killer)
7. [ ] **M9 / OUT-OF-CODE** — Enroll 15 real learners at an NGO/school. Run TC1–TC3. Capture completion rate.

**Mr Fox's Note to Abheejit**: System runs. Login confirmed. FSM editor is live. The CORS fix took 3 minutes to diagnose and deploy — that's the kind of sharp execution that gets noticed. 20/21 criteria in one session is a strong M8. The one missing piece (assign FSM to course) ships in 45 minutes at the start of next session. Then merge to main. Then stop building and get real users in the system. The pilot data is the unlock for every funder conversation. Don't build M9 features until a real person in a real school has gone through TC1–TC3.

---

### Engineering Audit — Milestone 8
**Auditor**: Arjun (Staff SWE, 13yr)
**Status**: NEEDS_WORK
**Readability Assessment**:
  - Naming clarity: Clear. `fsmDefinitions`, `toRFNodes`, `toRFEdges`, `toFsmJson` are intention-revealing. `_nodeCounter` global is a minor smell — module-level mutable state for ID generation.
  - Function/class size: FSMEditor.tsx 300 lines — acceptable for a canvas page. Largest handler is `addNode` at 15 lines. No bloat.
  - Code cohesion: Coherent. fsm.ts is pure route logic. CourseEditor additions are additive and isolated.
**Test Quality**:
  - Coverage of logic paths: Zero. No tests for any M8 changes — no route tests, no component tests.
  - Test fidelity: N/A (no tests exist anywhere in the codebase — pre-existing pattern, not M8-introduced)
  - Test maintainability: N/A
**Duplication & Consistency**:
  - Duplicated logic: `fsmJson size cap` check copied verbatim in POST and PUT `/api/fsm` — minor duplication, low divergence risk. Could be extracted as a 3-line helper.
  - Style/pattern consistency: Follows repo conventions. `getDb()` dynamic import pattern consistent. `requireRole()` middleware chain consistent.
**CI/CD Hygiene**: No linting, no type checks, no automated tests in pipeline — manual `railway up` only. Pre-existing.
**Dead Code / TODOs**:
  - `apps/backend/dist/` committed to git — build artifacts tracked in source control. Two sources of truth. Not used by Railway (it runs its own build). Adds ~50 lines of churn per build to diffs.
  - `MOCK_COURSES` fallback in `CourseEditor.tsx` page (pre-existing). Still present, only bypassed when API returns data.
**Refactor Targets** (ordered by cost-of-change):
  1. Extract fsmJson size cap into shared validator const — avoids silent divergence between POST and PUT limits
  2. Remove `dist/` from git tracking — add to `.gitignore`, clean with `git rm -r --cached apps/backend/dist`
**Recommendations**:
  - Fix now: dist/ in git (noise + risk of serving stale build)
  - Log as debt: test coverage, MOCK_COURSES cleanup, size cap deduplication

---

### Design Audit — Milestone 8
**Auditor**: Divya (Principal UX, 11yr)
**Status**: ITERATE
**User Flow Assessment**:
  - Primary action path (admin designs a course flow): Open FSM Editor → create/select flow (2 clicks) → add nodes via badge buttons → connect by dragging → Save. 5 steps, all visible. Clean.
  - Drop-off risks: Node label not editable in-place. Once a node is created with default label "Lesson", user cannot rename it without knowing to double-click the React Flow default node (no affordance for this). Will generate support questions from non-technical NGO admins.
**Information Hierarchy**: Clear primary action (canvas takes 80% of viewport). Add node badges are prominent. Save button right-aligned in toolbar — conventional, findable.
**Feedback & Error States**:
  - Success feedback: "Saved" toast on manual save ✅. "Saving…" text during auto-save pending ✅.
  - Error messages: Toast with error message on save failure ✅. "Failed to load" Alert on definition fetch error ✅.
  - Loading/empty states: Skeleton for flow list loading ✅. Skeleton for canvas loading ✅. "No flows yet" empty state with guidance ✅. "Select a flow" empty canvas state with icon ✅.
**Consistency Check**:
  - Interaction patterns: FSM sidebar collapsible panel is the only collapsible element in the product — inconsistent with rest of admin UI. Not broken, just different.
  - Visual language: Node type colours (green/blue/amber/red) are clear but not documented anywhere for users. A legend on the canvas would help first-time NGO admins.
**Accessibility Gaps**: No `aria-label` on collapse toggle button. Badge "click to add node" has no keyboard interaction. Not blocking for admin tool, but worth tracking.
**Mobile/Responsive**: Canvas editor is desktop-only — appropriate for an admin tool. Not a finding.
**Iterate Targets**:
  1. Node label editing: Add an `onDoubleClick` handler or right-click menu with "Rename" option. NGO admins expect this.
  2. Node type legend: A small colour-coded legend ("Start | Lesson | Question | End") on the canvas or in the empty state.
  3. FSM dropdown label in CourseEditor: "Learning Flow (FSM)" — the "(FSM)" is jargon for a non-technical admin. Rename to "Learning Flow" or "Course Flow".
**Recommendations**: All three are 30-minute fixes. Ship node renaming before first pilot — it will be the first thing every non-technical user asks about.

---

### DevOps Audit — Milestone 8
**Auditor**: Sanjay (Platform/SRE, 12yr)
**Status**: OPERATIONAL_RISK
**Deployability**:
  - Deploy process: `railway up --service {name} --detach` — reproducible and documented in session log ✅. Both services (ekatra-platform + ekatra-frontend) deploying separately.
  - Environment config: Railway env vars for DATABASE_URL, JWT_SECRET, FRONTEND_URL — clean dev/prod separation via Railway environments ✅. Variables are not documented in a `.env.example` — tribal knowledge risk.
  - Rollback path: Railway dashboard has 1-click rollback per service. Not documented anywhere in project.
**Observability**:
  - Logging: Structured JSON logger in production (module, level, timestamp, message fields) ✅.
  - Health endpoints: `/health` with DB connectivity check present ✅.
  - Alerting/monitoring: None — acceptable for pre-revenue pilot. Worth noting at first paid customer.
**Failure Behaviour**:
  - Downstream dependency failure: Neon DB timeout → 500 response with structured error log ✅. WhatsApp service: S3 `PutObject` fails (IAM permission missing for tech.intern@ekatra.one) → falls back to Cloudinary successfully ✅. Fallback is silent in production dashboard — operational surprise waiting.
  - Error visibility: Errors logged with context. No unhandled exception leak to client.
**CI/CD Pipeline**: Manual deploy only. No test gate before `railway up`. A broken route goes to production undetected. Pre-existing, not M8-introduced.
**Backup & Recovery**: Neon PostgreSQL automated daily backups ✅. No documented recovery procedure.
**Operational Debt**:
  - `apps/backend/dist/` committed to git — build artifacts in source control. Railway runs its own build; committed dist is never used. Creates confusion about which binary is authoritative.
  - No `.env.example` — new contributor (or post-memory-loss Abheejit) cannot reconstruct required vars.
  - S3 IAM policy missing for `tech.intern@ekatra.one` — silently failing in WhatsApp service, masking a broken integration.
**Recommendations** (by incident probability):
  1. Fix S3 IAM: either add `s3:PutObject` policy or remove S3 code path and commit to Cloudinary exclusively
  2. Add `.env.example` with all required var names (redacted values)
  3. Remove `dist/` from git tracking
  4. Document rollback procedure (one paragraph in README)
**Minimum Before Production** (real users with data): Current state acceptable for internal admin pilot. Not acceptable for deploying to schools/NGOs with learner data until S3/Cloudinary decision is explicit and documented.

---

### CTO Consolidated — Milestone M8 (v2 — post-deploy)
**Date**: 2026-04-07
**Mr Fox's Call**: PROCEED — M8 fully shipped, merged to main, on Railway production

**Executive Summary**: M8 is complete. All 21 acceptance criteria shipped (20 in the main sprint, FSM→course assignment in the close-out commit). Merged `milestone/8` → `main` at `247c1e8e`. Both services deployed to Railway. Three new agents (Arjun, Divya, Sanjay) surfaced 5 actionable items — none are blockers for pilot. The single hard blocker before NGO deployment is the S3 IAM credential issue: it's masked by Cloudinary fallback but represents a broken integration that will surprise the next operator.

**From Priya (Security)**: WARN — .env git history scrub still Abheejit's action. Temp password mitigated with Cache-Control + fsmJson size cap. No new critical findings in close-out commits.
**From Kavitha (PM)**: ON_TRACK — 21/21 criteria met as of commit 67211cbc. FSM→course assignment shipped. Merge complete. M8 fully delivered.
**From Rajan (Architecture)**: REVIEW_NEEDED — fsm_json schema coupling to React Flow, missing org_id index, narrow findAll projection. Not blocking for pilot.
**From Meera (Strategy)**: DISCUSS — Builder's Trap active. Pilot must come before M9 features. System is now ready to enroll real learners.
**From Arjun (Engineering)**: NEEDS_WORK — dist/ in git, zero tests, fsmJson size cap duplication. No blockers, all fixable in <1hr.
**From Divya (Design)**: ITERATE — Node renaming missing (top user ask from non-technical admins), node legend absent, "FSM" jargon in course editor label. 3×30min fixes.
**From Sanjay (DevOps)**: OPERATIONAL_RISK — S3 IAM broken (masked by Cloudinary), no .env.example, dist/ in git, no CI/CD. Acceptable for internal pilot; not acceptable for school/NGO deploy.

**Blocking Issues**: None for internal pilot. Before first external NGO deploy:
- [ ] **Abheejit** — Rotate .env secrets + git history scrub
- [ ] **S3 fix** — add `s3:PutObject` to tech.intern@ekatra.one IAM, or delete S3 code path

**Action Items** (prioritized):
1. [ ] **IMMEDIATE (Abheejit)** — Rotate Neon DB password + Meta WhatsApp token. Run: `git filter-repo --path .env --invert-paths && git push --force`
2. [ ] **M9 Day 1** — Fix S3: add IAM policy OR `rm -rf` the S3 upload path and commit to Cloudinary only
3. [ ] **M9 Day 1** — Add `.env.example` with all required var names (redacted)
4. [ ] **M9 quick** — Remove `apps/backend/dist/` from git: add to `.gitignore`, `git rm -r --cached apps/backend/dist`
5. [ ] **M9 quick** — FSMEditor: add node rename on double-click (30min, high pilot impact)
6. [ ] **M9 quick** — Add node type legend to FSMEditor canvas
7. [ ] **M9** — DB: `CREATE INDEX idx_fsm_defs_org ON fsm_definitions(organization_id)`
8. [ ] **M9** — FSMEditor: narrow `findAll` projection (exclude fsm_json from list query)
9. [ ] **PILOT** — Enroll 15 real learners at one NGO/school. Run TC1–TC3. Capture completion rate. This data is the unlock.

**Mr Fox's Note to Abheejit**: M8 is done. All 21 criteria, merged to main, live on Railway. Three new agents found nothing blocking — operational hygiene items, all fixable. The system is ready to run a pilot. The only thing between you and funder-ready traction data is enrolling real humans. Don't build M9 until a real learner has sent a WhatsApp message and received a lesson back. That moment is worth more than any feature.

---

## M9 Audit — 2026-04-09

### Security Audit — Milestone M9
**Auditor**: Priya (Principal AppSec, 16yr)
**Status**: WARN
**Attack Surface Changes**: LLM-generated content (module bodies, quiz questions, comprehension questions) written verbatim to DB and delivered over WhatsApp. New FSM button payloads: `doubt_yes`, `doubt_no`. Certificate filename constructed from AI-generated course title.
**Files Reviewed**: 5 (courseGenerator.ts, courseDelivery.ts, conversationFSM.ts, database/index.ts, migrations/004_day_number.sql)
**Critical**: None
**Warnings**:
- `courseGenerator.ts` — No field-length validation on LLM output before DB insert. Add `.slice(0, 2000)` on `content` and `.slice(0, 500)` on `question` before insert.
- `courseDelivery.ts:runDayEndReview` — Zero-question guard missing. If DB returns 0 comprehension Qs, doubt prompt fires with no preceding questions.
- `courseDelivery.ts:sendDocument` — Certificate filename built from raw course title. Sanitize: `courseTitle.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_')`.
**Dependency Risk**: No new dependencies.
**Data Flow Gaps**: LLM → lesson content → WhatsApp delivery with no sanitization layer. Acceptable at pilot scale.
**Fix Instructions**:
```ts
// courseGenerator.ts — before db.lessons.create:
content: (moduleData.content ?? '').slice(0, 2000),
// before db.quiz.createQuestion:
question: (q.question ?? '').slice(0, 500),
// courseDelivery.ts — runDayEndReview after findByLesson:
if (questions.length === 0) { logger.warn(`No comprehension Qs for ${reviewLesson.id}`); await this.markDayReviewComplete(enrollmentId, reviewLesson.id); return; }
// courseDelivery.ts — sendDocument filename:
filename: `Ekatra_Certificate_${courseTitle.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_')}.pdf`,
```

---

### PM Audit — Milestone M9
**Auditor**: Kavitha (Sr. TPM, 14yr)
**Status**: DRIFTED
**Criteria Scorecard** (reconstructed — no formal plan doc exists):
  - 3-5 days × 3-5 modules LLM generation: PASS
  - No flashcards at day-end: PASS
  - 3 comprehension questions per day: PASS
  - Day-boundary detection in delivery: PASS
  - Doubt loop until No: PASS
  - Certificate as PDF via sendDocument: PASS
  - Greeting shows Day X/Module Y: PASS
  - Restart resets to Day 1: PARTIAL — enrollment pointer reset, lessonProgress rows NOT cleared (ghost state)
  - Pacing 5-10s between modules: PARTIAL — 5s between same-day modules but sendNextLesson internal delays (1.2s+1.5s) unchanged
  - Comprehension question answer → doubt loop: FAIL — handleQuizResponse calls markLessonComplete on review lesson; markDayReviewComplete never called; doubt loop never fires
**Scope Creep**: `markDayReviewComplete` implemented (public, zero call sites). ~30 min unplanned work that is currently unreachable.
**Missed Deliverables**: Comprehension question → doubt loop chain is BROKEN. Learner finishing Day 1 is silently advanced to Day 2 without doubt prompt. Cannot demo or pilot with this broken.
**Technical Debt Introduced**:
  - `markDayReviewComplete` orphaned — HIGH
  - lessonProgress ghost state on restart — MEDIUM
  - No plan doc / Vikram review skipped — MEDIUM
**Demo/Report Readiness**: No — Day 1 end-to-end fails at the final step.
**Recommendations**:
1. Wire `markDayReviewComplete` into `handleQuizResponse` for review lessons — TODAY
2. Clear `lessonProgress` rows on restart
3. Create retroactive plan doc `.claude/plans/milestone-9-day-module-structure.md`
**Next Session Should Start With**: Fix the comprehension question → doubt loop routing bug. In `handleQuizResponse`, detect if the current lesson is a review lesson and call `markDayReviewComplete` instead of `markLessonComplete`.

---

### Architecture Audit — Milestone M9
**Auditor**: Rajan (Distinguished Eng, 18yr)
**Status**: REVIEW_NEEDED
**System Context**: ~15 learner pilot. Single Railway Node instance. Neon Postgres. Twilio WhatsApp. No queue.
**Structural Assessment**:
  - Module boundaries: `courseDelivery.ts` now owns lesson delivery + day-end orchestration + certificate issuance. Three responsibilities. Acceptable at pilot; split in M11+.
  - Data model: `content_type = 'review'` as lesson sentinel creates an implicit contract — every future feature iterating `findByCourse` must filter review lessons or silently break. Prefer `is_review BOOLEAN` column (M10).
  - API surface: No public API changes. Stable.
  - Error handling: `runDayEndReview` has no try/catch. Error on message 2-of-3 leaves learner mid-review with no recovery path.
**Pattern Consistency**: `delay()` defined independently in courseDelivery.ts and conversationFSM.ts — identical one-liner, minor inconsistency.
**Scalability Horizon**: Sequential delay loop breaks at ~10K concurrent learners. Not a concern today.
**Performance Concerns**: `sendNextLesson` runs `findByCourse` + `Math.max` spread on every module delivery. Negligible at pilot scale.
**Tech Debt vs Intentional Simplicity**: `content_type = 'review'` is intentional simplicity that will become a maintenance trap at scale. Flag for M10.
**Recommendations**:
1. (Fix now) Wrap `runDayEndReview` in try/catch with recovery message
2. (M10) Add `is_review` boolean column, migrate `content_type = 'review'` rows
3. (M10) Extract shared `delay` utility

---

### Strategic Audit — Milestone M9
**Auditor**: Meera (Venture Partner, 2x Founder, 20yr)
**Status**: ALIGNED
**Project Context Discovered**: Ekatra — AI-powered WhatsApp micro-learning for NGO/school learners in India. Small team. Live on Railway. Real pilot attempted → UX failures found → M9 rebuild driven by real feedback.
**Venture Impact**: Day×module structure restored into AI-generated pipeline. Comprehension questions + doubt loop are the pedagogical differentiators. Iteration cycle from pilot failure to fix to redeploy was same-session — strong proof-of-execution for funders.
**Strategic Leverage**: High — day structure is procurement expectation for NGO L&D buyers. Doubt loop is the "aha" differentiator vs PDF/static content.
**Cross-Project Reuse**: Doubt loop + comprehension pattern reusable in ekatra-maya. FSM logic is portable.
**Fundability Assessment**:
  - Active pipeline relevance: High — demo now shows structured 3-day course, not just a chatbot
  - Investor/funder narrative: "Piloted, found failures, rebuilt learning structure in one session, redeployed." Tight proof of iteration speed.
**Sustainability Check**: Yes — parameterised prompt is flexible and maintainable.
**Builder's Trap Warning**: Yellow. One broken feature (comprehension→doubt loop) means Day 1 doesn't complete correctly. Don't plan M10 on a broken Day 1. Fix first.
**Founder Decision Needed**: After bug fix — confirm timing of 15-learner NGO pilot. M10 priorities should come from pilot completion rate data, not assumptions.
**Recommendations**:
1. Fix comprehension→doubt loop routing bug today
2. Run one full internal end-to-end before enrolling real learners
3. M10 planning only after pilot data exists

---

### Engineering Audit — Milestone M9
**Auditor**: Arjun (Staff SWE, 13yr)
**Status**: NEEDS_WORK
**Readability Assessment**:
  - Naming clarity: Good overall. `content_type = 'review'` is a stringly-typed sentinel — one typo breaks the flow silently.
  - Function/class size: `markLessonComplete` is ~100 lines doing 3 things. Largest function in service.
  - Code cohesion: M9 diff is coherent — all changes serve day×module goal.
**Test Quality**:
  - Coverage: Zero. The broken comprehension→doubt loop would be caught by a single 20-line integration test.
  - Highest-risk untested path: review lesson answer → `markDayReviewComplete` chain.
**Duplication & Consistency**:
  - `delay()` defined independently in courseDelivery.ts and conversationFSM.ts.
  - `(learner?.name || '').split(' ')[0] || ''` appears 3+ times in courseDelivery.ts. Extract to `getFirstName(learner)`.
**CI/CD Hygiene**: `tsc --noEmit` passes. No automated test runner. No CI gate before deploy.
**Dead Code / TODOs**:
  - `markDayReviewComplete` — public, zero call sites (this is the bug's symptom)
  - `sendLessonContent` — private, zero call sites, dead since M7
**Refactor Targets**:
1. Wire `markDayReviewComplete` into `handleQuizResponse` — this is the bug fix
2. Remove `sendLessonContent` (5 min)
3. Extract `getFirstName(learner)` helper (10 min)
4. Split `markLessonComplete` into day-advance and course-complete paths (M10, 30 min)
**Recommendations**:
1. Fix now: wire `markDayReviewComplete` call site in handleQuizResponse
2. Fix now: 0-question guard in runDayEndReview
3. M10: 3 integration tests for day-boundary flow
4. M10: remove dead sendLessonContent, extract getFirstName

---

### Design Audit — Milestone M9
**Auditor**: Divya (Principal UX, 11yr)
**Status**: ITERATE
**User Flow Assessment**:
  - Primary action path: module → quiz → "Next Module" tap → next module. Clean, 3 interactions per module.
  - Drop-off risk: 3 comprehension Qs sent sequentially with 5s delays. WhatsApp ordering not guaranteed on slow connections — learner may see Q2 before Q1 tap is registered.
**Information Hierarchy**: `📚 Day 1/3 · Module 2/3` header is a clear improvement. But `pct` in `sendNextLesson` calculates `(lessons before current / total)` → first module always shows 0%. Should count completed modules.
**Feedback & Error States**:
  - Success: module acknowledgement + progress % — clear.
  - "See you tomorrow" — good closure signal.
  - Doubt loop "Any other doubts?" — unambiguous.
  - Error: `runDayEndReview` failure leaves learner in silence. No recovery message.
**Consistency Check**: `hi`/`hello` → progress + "Continue" button — consistent. `restart` flow (text + 2s + first module) — clean.
**Accessibility Gaps**: All button labels under 20 chars. Twilio limits respected.
**Mobile/Responsive**: WhatsApp native — N/A.
**Redesign Targets**:
  - 0% progress on first module: fix `pct` calculation in `sendNextLesson`
  - Silent failure on `runDayEndReview` error: add recovery message to catch block
**Recommendations**:
1. Fix 0% on first module — trivial
2. Add "Something went wrong. Reply *next* to continue." to runDayEndReview catch
3. Consider batching 3 comprehension questions in one message (numbered list) — eliminates WhatsApp ordering risk

---

### DevOps Audit — Milestone M9
**Auditor**: Sanjay (Platform/SRE, 12yr)
**Status**: OPERATIONAL_RISK
**Deployability**:
  - Deploy process: Railway auto-deploy on push to main. Commit 6888e711 live.
  - Environment config: No new env vars. Migration `004_day_number.sql` applied manually in-session — NOT in automated runner. New environment or DB reset will crash app on first course generation (missing column).
  - Rollback path: No git tag for v2.9.0. Manual `git revert` only.
**Observability**:
  - Logging: Good in courseGenerator. `runDayEndReview` has zero logs — failure invisible in Railway dashboard.
  - Health endpoints: Unchanged from M8.
  - Alerting: None. Railway dashboard only.
**Failure Behaviour**:
  - LLM failure: 3-retry with backoff — good.
  - `runDayEndReview` failure: no try/catch, no fallback — hard crash, learner receives nothing.
  - `sendDocument` failure: no fallback — certificate flow fails silently if PDF URL unreachable.
**CI/CD Pipeline**: None. Push = deploy. Zero test gate.
**Backup & Recovery**: Neon assumed daily snapshots. Not verified.
**Operational Debt**:
  - Migration 004 not in automated runner
  - No CHANGELOG entry for M9
  - milestones.md not updated with M9 entry or version bump
**Recommendations**:
1. Fix now: document migration 004 apply step in `.claude/docs/deployment/` or README
2. Fix now: wrap `runDayEndReview` in try/catch + fallback message
3. M10: `sendDocument` → `sendText(url)` fallback
4. M10: tag `v2.9.0` on known-good commit
**Minimum Before Production**: Migration 004 must be documented or in an automated apply path.

---

### CTO Consolidated — Milestone M9
**Date**: 2026-04-09
**Mr Fox's Call**: FIX_REQUIRED

**Executive Summary**: M9 delivered the right structural changes — day×module LLM generation, day-boundary detection, doubt loop, certificate as PDF, "Next Module" UX. TypeScript compiles clean. One functional bug makes the Day 1 end-to-end broken: comprehension question answers route through `handleQuizResponse → markLessonComplete` instead of `markDayReviewComplete`, meaning the doubt loop is never triggered. A learner finishing Day 1 is silently advanced to Day 2. Fix is ~15 lines. Two additional issues (missing try/catch in `runDayEndReview`, 0% progress bar on first module) go in the same commit.

**From Priya (Security)**: WARN — No blocking findings. LLM output length guards missing, 0-question guard missing, certificate filename needs sanitization. All fixable in 30 min.
**From Kavitha (PM)**: DRIFTED — 8/10 criteria pass. Comprehension→doubt loop chain broken. Restart ghost state. No plan doc. Milestone cannot be called complete until bug fixed.
**From Rajan (Architecture)**: REVIEW_NEEDED — `content_type = 'review'` sentinel creates implicit contract. `runDayEndReview` lacks error handling. Otherwise sound for pilot scale.
**From Meera (Strategy)**: ALIGNED — Pilot-driven iteration, fast cycle, fundable story. Don't build M10 on a broken Day 1.
**From Arjun (Engineering)**: NEEDS_WORK — `markDayReviewComplete` orphaned (zero call sites — this IS the bug). `sendLessonContent` dead since M7. Zero tests.
**From Divya (Design)**: ITERATE — Day/Module header is a real improvement. Two fixes: 0% progress on first module, silent failure on runDayEndReview error.
**From Sanjay (DevOps)**: OPERATIONAL_RISK — Migration 004 not in automated runner. `runDayEndReview` no try/catch. No release tag. No CHANGELOG update.

**Blocking Issues**:
- [ ] **BUG** — `handleQuizResponse` must detect review lesson → call `markDayReviewComplete` instead of `markLessonComplete`. This is the broken comprehension→doubt loop chain.
- [ ] **OPERATIONAL** — Wrap `runDayEndReview` in try/catch with fallback message
- [ ] **OPERATIONAL** — Document migration 004 apply step for new environments

**Action Items**:
1. [ ] **TODAY** — Fix `handleQuizResponse`: if `current_lesson.content_type === 'review'`, call `courseDelivery.markDayReviewComplete` instead of `markLessonComplete`
2. [ ] **TODAY** — Add try/catch to `runDayEndReview` + fallback: `"Something went wrong with your review. Reply *next* to continue."`
3. [ ] **TODAY** — Add 0-question guard in `runDayEndReview` (Priya + Arjun)
4. [ ] **TODAY** — Add M9 entry to `milestones.md`, version `v2.9.0`
5. [ ] **THIS WEEK** — Fix 0% progress on first module in `sendNextLesson` (Divya)
6. [ ] **THIS WEEK** — Clear `lessonProgress` rows on restart (Kavitha)
7. [ ] **THIS WEEK** — Sanitize certificate filename (Priya)
8. [ ] **THIS WEEK** — Add LLM output field-length guards in courseGenerator (Priya)
9. [ ] **THIS WEEK** — Tag `v2.9.0` after bug fix commit; update CHANGELOG
10. [ ] **M10** — Replace `content_type = 'review'` with `is_review` boolean column (Rajan)
11. [ ] **M10** — Remove dead `sendLessonContent`; extract `getFirstName` helper (Arjun)
12. [ ] **M10** — Add 3 integration tests for day-boundary flow
13. [ ] **PILOT** — Run full internal end-to-end: Day 1 start → all modules → comprehension Qs → doubt loop → "See you tomorrow". Then enroll 15 real learners.

**Mr Fox's Note to Abheejit**: M9 is 90% there. All the right pieces are in place — the architecture is sound, the UX is a real improvement, and you got here from a live pilot failure in a single session. That's impressive. But there's one broken wire: learners who finish Day 1's modules will answer their comprehension questions and be silently pushed to Day 2 without ever seeing the doubt loop. The fix is about 15 lines in `handleQuizResponse`. Do that today, run one full internal test end-to-end, then enroll the NGO cohort. Don't let a 15-line bug sit between you and real learner data.

---

## M9 Stabilization Audit — 2026-04-12

### Security Audit — Milestone M9 Stabilization
**Auditor**: Priya (Principal AppSec, 16yr)
**Status**: WARN
**Attack Surface Changes**: `start_lesson` and `start_lesson_restart` button paths added; global input normalization in FSM; admin `/api/admin/simulate` used for operational testing.
**Files Reviewed**: 3 (`apps/backend/src/flows/conversationFSM.ts`, `apps/backend/src/services/courseDelivery.ts`, `apps/worker/src/jobs/flashcardReminder.ts`)
**Critical**: None
**Warnings**:
- `apps/backend/src/flows/conversationFSM.ts` — global `input = lower` normalization affects all states. It fixes payload variants but increases risk of semantic drift in future state handlers if raw payload distinctions are needed.
- `apps/backend/src/flows/conversationFSM.ts` — restart path (`start_lesson_restart`) re-sends lesson content without explicit rate limiting per learner; admin misuse could spam a learner.
**Dependency Risk**: No new dependencies.
**Data Flow Gaps**: Inbound button payload → FSM → outbound message is now correct, but transport-level failures (`63016`, `63049`) still prevent message delivery in real runs.
**Fix Instructions**:
1. Add a lightweight per-learner cooldown for `start_lesson_restart` in FSM metadata (e.g., 5-10s).
2. Add structured logging fields for branch decision (`none|started|completed`) at `start_lesson` to improve incident triage.

---

### PM Audit — Milestone M9 Stabilization
**Auditor**: Kavitha (Sr. TPM, 14yr)
**Status**: ON_TRACK
**Criteria Scorecard**:
  - `Start Lesson` payload casing normalized globally: PASS — `input = lower` applied before state switch.
  - Learning-state re-entry branching by lesson progress: PASS — `none|started|completed` branches implemented.
  - Mid-module UX choice (`Continue` / `Restart Module`): PASS — interactive button prompt added.
  - Restart path re-delivery (`start_lesson_restart`): PASS — explicit handler added.
  - Flashcard reminder wording update: PASS — dynamic pluralized var shipped.
  - Runtime branch validation: PASS — local 3-branch matrix executed with DB restore.
**Scope Creep**: Added docs updates (`.claude/*`) in same commit as runtime fix; low impact.
**Missed Deliverables**: None for stabilization scope.
**Technical Debt Introduced**: Manual SQL state mutation required for branch test harness (MEDIUM, operational test debt).
**Demo/Report Readiness**: Yes for engineering demo; production WhatsApp transport reliability still affects external demo confidence.
**Recommendations**:
1. Add a deterministic test fixture route for branch-state simulation to avoid direct SQL mutation.
2. Keep this patch as `v2.9.1` stabilization in release notes.
**Next Session Should Start With**: Production smoke run on a dedicated test learner and capture Twilio error-code breakdown.

---

### Architecture Audit — Milestone M9 Stabilization
**Auditor**: Rajan (Distinguished Eng, 18yr)
**Status**: REVIEW_NEEDED
**System Context**: Pilot-scale WhatsApp backend on Railway + Neon; correctness and operability over scale.
**Structural Assessment**:
  - Module boundaries: FSM routing remained within `conversationFSM.ts`; delivery logic stayed in `courseDelivery.ts`. Clean separation maintained.
  - Data model: No schema changes. Branching relies on `lesson_progress.status` semantics (`none|started|completed`) — acceptable but implicit contract.
  - API surface: No public API contract changes.
  - Error handling: `runDayEndReview` try/catch + zero-question guard is now robust for this path.
**Pattern Consistency**: New handlers follow existing learning-state pattern.
**Scalability Horizon**: No meaningful shift; still appropriate for current pilot load.
**Performance Concerns**: Extra lookups in `start_lesson` path (enrollment + progress + lesson) are acceptable at pilot scale.
**Tech Debt vs Intentional Simplicity**: Intentional simplicity is acceptable; missing automated branch tests is now the main fragility.
**Recommendations**:
1. Add integration tests for `start_lesson` branches with mocked DB state.
2. Extract branch selection logic into a pure helper to reduce FSM complexity.

---

### Strategic Audit — Milestone M9 Stabilization
**Auditor**: Meera (Venture Partner, 2x Founder, 20yr)
**Status**: ALIGNED
**Project Context Discovered**: Post-M9 stabilization pass focused on learner continuation reliability and day-structured flow integrity.
**Venture Impact**: Re-entry reliability is directly tied to completion rates; this patch protects the core pilot metric.
**Strategic Leverage**: High
  - It reduces learner drop-off at day boundaries, which is the exact metric funders care about.
**Cross-Project Reuse**: FSM branch pattern is reusable across other WhatsApp learning flows.
**Fundability Assessment**:
  - Active pipeline relevance: High — reliability fixes are stronger narrative than new features.
  - Investor/funder narrative: “Detected live flow break, shipped stabilization, validated branches” is credible execution evidence.
**Sustainability Check**: Good; no new infra burden.
**Builder's Trap Warning**: Low for this patch; this is a shipping-quality fix, not feature creep.
**Founder Decision Needed**: Lock M9 as stabilization complete and move to pilot execution metrics.
**Recommendations**:
1. Freeze non-pilot features until one full NGO cohort run is completed.
2. Capture completion funnel after this patch for next funder update.

---

### Engineering Audit — Milestone M9 Stabilization
**Auditor**: Arjun (Staff SWE, 13yr)
**Status**: NEEDS_WORK
**Readability Assessment**:
  - Naming clarity: Clear branch naming (`start_lesson`, `start_lesson_restart`).
  - Function/class size: `handleLearning` grew further; complexity rising.
  - Code cohesion: Cohesive fix set around re-entry and continuation logic.
**Test Quality**:
  - Coverage of logic paths: Missing automated tests for the new 3-branch decision path.
  - Test fidelity: Manual matrix run proves behavior but is non-repeatable in CI.
  - Test maintainability: N/A for current manual test procedure.
**Duplication & Consistency**:
  - Duplicated logic: Branch handling for completion/review still appears in multiple points.
  - Style/pattern consistency: Consistent with existing async FSM style.
**CI/CD Hygiene**: Type-check passes; no integration tests added.
**Dead Code / TODOs**: None added in this patch.
**Refactor Targets**:
1. Extract re-entry branch decision into helper function.
2. Add unit/integration tests for `start_lesson` and `start_lesson_restart` flows.
**Recommendations**:
1. Fix now: automated test for `none|started|completed` branches.
2. Next: trim branching in `handleLearning` to avoid future regressions.

---

### Design Audit — Milestone M9 Stabilization
**Auditor**: Divya (Principal UX, 11yr)
**Status**: APPROVED
**User Flow Assessment**:
  - Primary action path: daily reminder → `Start Lesson` now maps to relevant continuation behavior.
  - Drop-off risks: Reduced; users no longer hit ambiguous completed-course fallback for in-progress continuation.
**Information Hierarchy**: Mid-module prompt is clear and action-oriented.
**Feedback & Error States**:
  - Success feedback: `Continue` / `Restart Module` gives explicit control.
  - Error messages: Existing transport failures are external; app-side fallback text remains usable.
  - Loading/empty states: N/A for WhatsApp flow.
**Consistency Check**:
  - Interaction patterns: Button-driven continuation aligns with the rest of the learning flow.
  - Visual language: Consistent with existing WhatsApp prompts.
**Accessibility Gaps**: None new.
**Mobile/Responsive**: Applicable and appropriate (WhatsApp-native).
**Redesign Targets**: None required for this stabilization patch.
**Recommendations**:
1. Keep prompt copy short and deterministic for multilingual learners.
2. Add a transport-failure fallback retry hint in future if Twilio drop rate persists.

---

### DevOps Audit — Milestone M9 Stabilization
**Auditor**: Sanjay (Platform/SRE, 12yr)
**Status**: OPERATIONAL_RISK
**Deployability**:
  - Deploy process: push-to-main auto-deploy worked.
  - Environment config: unchanged.
  - Rollback path: still manual revert/tag workflow.
**Observability**:
  - Logging: adequate for app path; branch-level diagnostics could be richer.
  - Health endpoints: healthy in production.
  - Alerting/monitoring: still minimal; Twilio error rates observed via logs only.
**Failure Behaviour**:
  - Downstream dependency failure: Twilio delivery failures (`63016`, `63049`) persist, causing undelivered reminders/responses.
  - Error visibility: visible in `message_log.metadata` and status callbacks.
**CI/CD Pipeline**: Manual validation + typecheck; no automated message-flow smoke in deploy gate.
**Backup & Recovery**: unchanged.
**Operational Debt**:
  - No automated post-deploy synthetic WhatsApp flow check.
  - Test matrix required direct SQL mutation of seed records.
**Recommendations**:
1. Add post-deploy synthetic test via `/api/admin/simulate` + assertion on outbound status transitions.
2. Build Twilio error-code dashboard/count to track reliability regressions.
**Minimum Before Production**: Current state acceptable for controlled pilot; transport reliability must be measured and mitigated before broader NGO rollout.

---

### CTO Consolidated — Milestone M9 Stabilization
**Date**: 2026-04-12
**Mr Fox's Call**: PROCEED
**Executive Summary**: The inter-day re-entry stabilization patch shipped and branch behavior is now correct: `Start Lesson` routes by current lesson state (`none|started|completed`) and no longer falls into the old generic completion fallback. Local branch-matrix validation passed with state restoration. Remaining risk is operational (Twilio delivery reliability), not core flow correctness.
**From Priya (Security)**: WARN — no critical exploit path introduced; minor operational hardening still needed.
**From Kavitha (PM)**: ON_TRACK — stabilization scope delivered and validated.
**From Rajan (Architecture)**: REVIEW_NEEDED — design is sound for pilot, but branch logic needs automated tests.
**From Meera (Strategy)**: ALIGNED — this directly supports pilot completion-rate narrative.
**From Arjun (Engineering)**: NEEDS_WORK — no automated tests for new branch logic.
**From Divya (Design)**: APPROVED — continuation UX is now explicit and coherent.
**From Sanjay (DevOps)**: OPERATIONAL_RISK — Twilio undelivered errors remain active.
**Blocking Issues**: None blocking internal pilot execution.
**Action Items**:
1. [ ] Add automated integration test for `start_lesson` branch matrix (`none|started|completed`).
2. [ ] Add post-deploy synthetic simulate check to CI/release checklist.
3. [ ] Track Twilio error codes (`63016`, `63049`) with daily counts during pilot.
4. [ ] Execute one production E2E run on dedicated pilot test learner and archive logs.
5. [ ] Update CHANGELOG as `v2.9.1` stabilization patch.
**Mr Fox's Note to Abheejit**: This is the right kind of work — you fixed a real flow break that impacts completion, validated it systematically, and restored state cleanly. Ship the pilot run next and collect the one metric that matters: day-to-day continuation and completion.
