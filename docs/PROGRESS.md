# EKATRA — Progress & Milestones

Living document. Updated at the end of every session.  
Full plan: [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) | Vision: [`/docs/EKATRA_CLAUDE.md`](../../docs/EKATRA_CLAUDE.md)

---

## Current State At-a-Glance

| Area | Status | Notes |
|------|--------|-------|
| Backend server | ✅ Running | Express + TypeScript, port 3001, `pnpm dev` |
| Database | ✅ Connected | Neon PostgreSQL + pgvector |
| WhatsApp messaging | ✅ Wired | Meta Cloud API, phone +1 980-998-2030 |
| AI (Azure OpenAI) | ✅ Configured | GPT-4o default, gpt-4o-mini for Q&A |
| Auth (JWT) | ✅ Done | login / me / seed endpoints |
| Conversation FSM | ✅ Done | 8 states, persisted in `learner.metadata.fsm` |
| AI course generation | ✅ Done | GPT-4o, 3-retry, dedup, lesson cap |
| Q&A (Socratic tutor) | ✅ Done | gpt-4o-mini, context-capped, conversation memory |
| Dashboard (frontend) | ✅ Exists | React + shadcn, 11 pages, wired to API |
| End-to-end WhatsApp test | ⚠️ Partial | FSM ✅ all states; Azure endpoint NXDOMAIN |
| Spaced repetition (FSRS) | ❌ Not started | Phase 3 |
| Multi-agent system | ❌ Not started | Phase 4 |
| Content types (image/audio/video) | ❌ Not started | Phase 3/4 |
| Knowledge graph | ❌ Not started | Phase 4 |
| CI/CD | ❌ Not started | Phase 5 |

---

## Session Log

### Session 1 — March 26, 2026

**Goals:** Understand current state, pick primary codebase, build plan.

**Decisions:**
- Chose `active/ekatra-platform` (TypeScript + PostgreSQL + Azure OpenAI) as sole primary codebase
- `active/ekatra-whatsapp` → reference only, port patterns but don't maintain
- Target: general WhatsApp users as test market; underserved populations (rural India, refugee camps, FMCG teams) as core mission
- Architecture: TypeScript agents (not Python/CrewAI), PostgreSQL not Cosmos DB, Azure App Service not Azure Functions

**Built (Phase 1 — complete):**
- `services/courseGenerator.ts` — GPT-4o course generation → saves courses + lessons + quizzes to DB
- `flows/conversationFSM.ts` — 8-state FSM (idle → topic → goal → confirm → generating → learning → doubt → complete), state stored in `learner.metadata.fsm`
- `services/messageHandler.ts` — replaced 250-line routing logic with thin FSM delegator
- `middleware/auth.ts` — JWT middleware (`authMiddleware`, `optionalAuth`, `signToken`)
- `routes/auth.ts` — `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/seed`
- `routes/courses.ts` — added `POST /api/courses/generate`
- `index.ts` — registered auth routes, protected admin APIs with `authMiddleware`, fixed `META_*` env vars
- `.env` — added `JWT_SECRET`, `ADMIN_SEED_KEY`
- Installed: `jsonwebtoken`, `bcryptjs`, `@types/jsonwebtoken`, `@types/bcryptjs`

**Verified:** `GET /health` → 200, `GET /api/courses` (no token) → 401, `POST /api/auth/login` (bad creds) → 401

---

### Session 2 — March 27, 2026

**Goals:** Evaluate plan against vision, implement Phase 2 resource fixes.

**Plan evaluation findings:**
- Architecture simpler than vision (no Service Bus, no Cosmos DB) — acceptable for current scale
- Critical gap: Q&A was sending ALL completed lessons as context to GPT-4o on every message (unbounded cost)
- No course deduplication — 100 learners on "Python basics" = 100 GPT-4o calls
- Vision specifies 3-tier model routing; plan only needs 2 tiers for now (GPT-4o + gpt-4o-mini)
- 65% completion claim needs spaced repetition (the core mechanism) — currently unbuilt
- Target audience confirmed: underserved populations (refugee camps, rural India, FMCG field sales teams)
- Content vision confirmed: text + image + audio + video (sourced + generated)
- Knowledge graph, conversation memory, org B2B features all required (later phases)

**Built (Phase 2 partial):**
- `lib/azureOpenAI.ts` — added `model: 'mini' | 'default'` param to `createChatCompletion()`; resolves to `AZURE_OPENAI_MINI_DEPLOYMENT` env var
- `services/qaService.ts`:
  - Context capped to current + previous lesson only (was: all completed lessons) → ~60-80% token reduction
  - Conversation history stored in `learner.metadata.conversationHistory` (last 10 pairs, 20 messages)
  - Switched to `model: 'mini'` (gpt-4o-mini) for all Q&A responses
  - Response token cap: 500 → 300
- `services/courseGenerator.ts`:
  - Deduplication: checks for existing published course with matching topic slug before calling GPT-4o
  - Lesson count capped at 7 max
- `.env` — added `AZURE_OPENAI_MINI_DEPLOYMENT=gpt-4o-mini`

**Plan saved to:** `docs/EXECUTION_PLAN.md` (permanent, in-repo)

**TypeScript:** Clean compile (exit 0) after all changes.

### Session 3 — March 27, 2026 (E2E Test)

**Goals:** Run end-to-end WhatsApp FSM test.

**Setup done:**
- Added missing env vars: `JWT_SECRET`, `ADMIN_SEED_KEY`, `AZURE_OPENAI_MINI_DEPLOYMENT=gpt-4o-mini`
- Built workspace packages (`@ekatra/database`, `@ekatra/messaging`), started server on port 3002
- Seeded admin: `admin@ekatra.io / Ekatra2026!` (org: Ekatra, org_id auto-created)

**FSM test results (via POST /api/webhooks/wati):**

| Step | Input | State transition | Result |
|------|-------|-----------------|--------|
| 1 | "Hi" (new user) | — | Learner created, welcome sent, FSM primed → `topic_input` |
| 2 | "Python basics" | `topic_input → goal_input` | ✅ Goal buttons sent |
| 3 | "I want to learn for data analysis" | `goal_input → confirming` | ✅ Confirmation card sent |
| 4 | "Yes" | `confirming → generating` | ✅ "Generating…" message sent, async fired |
| 5 | (Azure call) | — | ❌ DNS failure: `ENOTFOUND aeka-mf7uw5hr-swedencentral.cognitiveservices.azure.com` |
| 6 | (recovery) | `generating → topic_input` | ✅ User notified, state reset cleanly |

**Bugs found and fixed this session:**

1. **Bug (fixed):** First message "Hi" was being treated as a topic.  
   Root cause: `messageHandler.ts` called `conversationFSM.process()` even for brand-new learners, after `createLearner()` had already primed the FSM.  
   Fix: Added `isNewLearner` flag; early-return after create so the priming message isn't doubled.

2. **Bug (fixed):** Generation failure error message didn't distinguish connection errors.  
   Fix: `conversationFSM.ts` `generateCourseAsync()` now detects `ENOTFOUND`/`ECONNREFUSED` and sends "I'm having trouble reaching the AI service" vs generic error.

**Blocker — Azure OpenAI endpoint NXDOMAIN:**
- `nslookup aeka-mf7uw5hr-swedencentral.cognitiveservices.azure.com` → `NXDOMAIN`
- The Azure OpenAI resource does not exist at that hostname. Either it was deleted or the name is wrong.
- **Action required:** Go to [portal.azure.com](https://portal.azure.com) → Azure OpenAI → copy the correct endpoint URL, then update `AZURE_OPENAI_ENDPOINT` in `apps/backend/.env`
- The deployment names (`gpt-4o` and `gpt-4o-mini`) also need to match what's deployed in that resource.

**TypeScript compile:** Exit 0 after all fixes.

---



**Fix Azure first (5 min):**
1. Go to portal.azure.com → Azure OpenAI → copy the endpoint URL (format: `https://<name>.openai.azure.com/`)
2. Update `AZURE_OPENAI_ENDPOINT` in `apps/backend/.env`
3. Confirm deployment names: `AZURE_OPENAI_DEPLOYMENT=gpt-4o` and `AZURE_OPENAI_MINI_DEPLOYMENT=gpt-4o-mini`
4. Restart server: `PORT=3002 npx tsx apps/backend/src/index.ts`
5. Re-run: POST `/api/webhooks/wati` `{"waId":"919999000003","text":"Hi"}` → topic → goal → "Yes" → course generates → first lesson arrives

**Then — Phase 3 (spaced repetition):**
- `packages/database/` — add `flashcards` + `flashcard_progress` tables
- `packages/shared/src/fsrs.ts` — SM-2/FSRS algorithm
- `services/courseGenerator.ts` — generate 3 flashcards/lesson using gpt-4o-mini
- `flows/conversationFSM.ts` — add `review_flashcard` state
- `scheduler.ts` — daily cron for due flashcard delivery

---

## Key Technical Reference

### How to start the dev server
```bash
cd /Users/Shared/Scripts/ekatra-master/active/ekatra-platform
export PORT=3002   # 3001 may be held by suspended process
npx tsx apps/backend/src/index.ts
```

### FSM states
`idle → topic_input → goal_input → confirming → generating → learning → doubt → complete`  
State stored in: `learner.metadata.fsm = { state, data }`

### Environment variables (key ones)
```
DATABASE_URL=postgresql://neondb_owner:...@neon.tech/...
META_ACCESS_TOKEN=EAAPnCm...
META_PHONE_NUMBER_ID=your_phone_number_id
META_WEBHOOK_VERIFY_TOKEN=your_webhook_verify_token
AZURE_OPENAI_ENDPOINT=https://aeka-mf7uw5hr-swedencentral.cognitiveservices.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_MINI_DEPLOYMENT=gpt-4o-mini   ← set to your actual mini deployment name
JWT_SECRET=your_jwt_secret_min_32_chars
ADMIN_SEED_KEY=your_admin_seed_key
```

### DB repos available on `db`
`db.organizations`, `db.users`, `db.courses`, `db.lessons`, `db.learners`, `db.enrollments`, `db.quiz`, `db.lessonProgress`, `db.messageLog`, `db.embeddings`, `db.schedules`

### Import rules (ESM)
All local imports require `.js` extension: `import { x } from './lib/logger.js'`  
Workspace packages use lazy imports: `const getDb = () => import('@ekatra/database').then(m => m.db)`
