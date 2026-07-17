# EKATRA EXECUTION PLAN v4.0
## Foundation: ekatra-platform | Goal: Ship to Real Learners + Multi-Agent AI

**Date:** March 26, 2026  
**Primary Codebase:** `active/ekatra-platform/` (TypeScript + PostgreSQL + Azure OpenAI)  
**Vision:** `docs/EKATRA_CLAUDE.md` (multi-agent AI, 65% completion, $0.40-0.80/learner)  
**Decision:** Invest in ekatra-platform's cleaner architecture over ekatra-whatsapp

---

## CORE VISION

Ekatra is an AI-powered micro-learning platform delivering hyper-personalized education through WhatsApp. The mission: **reach 1 billion learners** with 65% course completion rates (vs industry 5-15%) at $0.40-0.80 per learner/month.

**How it works:**
1. Learner messages a WhatsApp number
2. AI generates a personalized micro-course (3-5 days, bite-sized lessons)
3. Daily lessons pushed via WhatsApp (text, image, audio, video)
4. Socratic AI tutor answers doubts through probing questions
5. Spaced repetition flashcards drive long-term retention
6. Multi-agent system adapts to each learner's knowledge state
7. Certificates issued on mastery (not just completion)

**Target users (first 100):** General WhatsApp users — anyone who wants to learn a topic fast.

---

## CURRENT STATE: ekatra-platform (as of March 2026)

### What Works ✅
- Express backend: 17 API endpoints, 4 services (~2,500 lines)
- PostgreSQL: 19 tables with pgvector for RAG embeddings
- WhatsApp Cloud API: text/image/video/audio/buttons/lists
- Frontend: 11-page React+shadcn dashboard, all wired to API
- Azure OpenAI Q&A: GPT-4o with Socratic system prompt
- Course delivery: scheduled push at 9AM IST, sequential lessons
- Quiz delivery + scoring
- Docker Compose (PostgreSQL + Redis + app)
- Deployed to Azure App Service ($18/month)
- **NEW (Phase 1):** AI course generation, conversation FSM (8 states), JWT auth

### What's Missing ❌
1. ~~AI Course Generation~~ ✅ Done
2. ~~Authentication~~ ✅ Done  
3. ~~Conversation FSM~~ ✅ Done
4. **Model routing** — GPT-4o for everything, no cost tiering
5. **Semantic cache** — duplicate questions cost full tokens every time
6. **Agent system** — `packages/agents/` doesn't exist
7. **Spaced repetition** — no flashcards, no FSRS
8. **Certificates** — no PDF generation
9. **CI/CD** — no deployment pipeline
10. **Cost tracking** — no per-learner economics

---

## EXECUTION PLAN

### Phase 1: Ship to Real Learners ✅ COMPLETE

**Deliverable:** Any WhatsApp user can text the number, say "I want to learn X", get an AI-generated course delivered daily, and ask questions.

| Task | Status | File |
|------|--------|------|
| AI course generation service | ✅ Done | `services/courseGenerator.ts` |
| Conversation FSM (8 states) | ✅ Done | `flows/conversationFSM.ts` |
| Wire FSM into messageHandler | ✅ Done | `services/messageHandler.ts` |
| JWT auth middleware | ✅ Done | `middleware/auth.ts` |
| Auth routes (login/me/seed) | ✅ Done | `routes/auth.ts` |
| POST /api/courses/generate | ✅ Done | `routes/courses.ts` |
| Register routes + fix env vars | ✅ Done | `index.ts` |

**FSM States:** `idle → topic_input → goal_input → confirming → generating → learning → doubt → complete`

---

### Phase 2: Resource Efficiency & Intelligence (Week 2-3) 🔴 NEXT

**Goal:** Cut AI costs to <$0.80/learner/month. Ground answers in course content. Avoid duplicate generation.

#### 2A. Model Routing (1 day) — CRITICAL
The biggest quick win. Currently every Q&A response uses GPT-4o (expensive). Most interactions are simple.

- Create `apps/backend/src/lib/modelRouter.ts`
- **Simple** (greetings, yes/no, button replies) → no LLM at all, rule-based
- **Q&A** (doubt questions, mid-lesson queries) → `gpt-4o-mini` (10× cheaper than GPT-4o)
- **Course generation** → `gpt-4o` (complex structured output, keep as-is)
- Add `AZURE_OPENAI_MINI_DEPLOYMENT` env var pointing to a `gpt-4o-mini` deployment
- Files: `lib/modelRouter.ts` (new), `services/qaService.ts` (modify to use mini model), `lib/azureOpenAI.ts` (add mini model support)

#### 2B. Course Deduplication (0.5 day) — CRITICAL
100 learners asking for "Python basics" = 100 identical GPT-4o calls today. Should be 1.

- Before generating: check DB for existing published course with same/similar topic
- Use simple slug match first, pgvector similarity search as fallback
- If match found (>0.85 similarity): enroll directly into existing course, skip generation
- Files: `services/courseGenerator.ts` (add dedup check at top of `generate()`)

#### 2C. Semantic Response Cache (2 days)
- Create `packages/shared/src/semanticCache.ts`
- Redis (already in docker-compose) as cache store
- Before every Q&A LLM call: embed query → similarity search in Redis → return if >0.92 cosine
- Target: 60% cache hit rate after 500+ Q&A exchanges
- Files: `semanticCache.ts` (new), `qaService.ts` (check cache before LLM call)

#### 2D. RAG: Ground Answers in Course Content (1-2 days)
- On course generation: embed each lesson chunk → store in `document_embeddings` table (already exists)
- On Q&A: retrieve top-3 lesson chunks relevant to question → inject into system prompt
- This cuts hallucinations AND reduces token usage (narrower context)
- Files: `courseGenerator.ts` (add embedding step after save), `qaService.ts` (add retrieval)

#### 2E. Cost Tracking (0.5 day)
- Add token counts to `message_log` table (new columns: `tokens_in`, `tokens_out`, `model_used`, `cost_usd`)
- Log every LLM call in `messageHandler.ts` / `courseGenerator.ts` / `qaService.ts`
- Add `GET /api/analytics/costs` endpoint
- Frontend: cost widget on dashboard

**Phase 2 Deliverable:** Dashboard shows cost/learner trending to <$0.80. Cache hit rate visible. 100 learners on "Python basics" = 1 LLM call, not 100.

---

### Phase 3: Spaced Repetition (Week 4) 📚

**Goal:** Flashcards + FSRS algorithm drive long-term retention.

#### 3A. Flashcard Generation (1 day)
- After AI generates course: also generate 3-5 flashcards per lesson (using `gpt-4o-mini`)
- Store in new `flashcards` + `flashcard_progress` tables
- Files: `courseGenerator.ts` (extend), `packages/database/` (new tables)

#### 3B. FSRS Algorithm (1-2 days)
- Create `packages/shared/src/fsrs.ts` — Free Spaced Repetition Scheduler
- SM-2 compatible: easeFactor, interval, repetitions, nextReviewDate
- Files: `fsrs.ts` (new)

#### 3C. WhatsApp Review Flow (1-2 days)
- Add `review_flashcard` states to FSM
- Daily cron: send due flashcards via WhatsApp, collect ratings (1-5)
- Files: `conversationFSM.ts` (extend), `scheduler.ts` (add flashcard cron)

#### 3D. Dashboard Retention View (0.5 day)
- Retention curves, due cards, mastery per learner
- Files: frontend analytics component

---

### Phase 4: Multi-Agent System (Weeks 5-7) 🎯 CORE DIFFERENTIATOR

**Goal:** Replace simple Q&A with intelligent agents that adapt to each learner.

#### 4A. Agent Infrastructure (2 days)
- Create `packages/agents/` package
- `BaseAgent` class: `process(context)`, tool execution, memory
- Agent registry: map intents → agents
- Use Azure OpenAI function calling (no CrewAI needed)
- Files: `packages/agents/src/base.ts`, `packages/agents/src/registry.ts`

#### 4B. Learner Profiler Agent (3 days)
- Track knowledge state per concept (BKT model): `Record<conceptId, mastery>`
- Store in `learners.metadata.knowledgeState` (existing JSONB column)
- Update mastery after quiz, Q&A, flashcard reviews
- Files: `packages/agents/src/learnerProfiler.ts`

#### 4C. Socratic Tutor Agent (3 days)
- Upgrade QAService → proper agent
- Ask probing questions instead of direct answers
- Track confusion signals, pivot after 2 failed attempts
- Files: `packages/agents/src/socraticTutor.ts`

#### 4D. Curriculum Architect Agent (3 days)
- Dynamic adaptation: inject remedial content when struggling, skip ahead when excelling
- RAG from pgvector for supplementary material
- Files: `packages/agents/src/curriculumArchitect.ts`

#### 4E. Assessment Agent (2 days)
- Adaptive difficulty quiz generation
- Explain why answers are right/wrong
- Certificate trigger on mastery (not just completion)
- Files: `packages/agents/src/assessmentAgent.ts`

#### 4F. Agent Orchestrator (2 days)
- Intent classification via `gpt-4o-mini` function calling
- Route: `start_course` → Curriculum, `ask_question` → Tutor, `take_quiz` → Assessment
- Files: `packages/agents/src/orchestrator.ts`

**Phase 4 Deliverable:** Learners interact with agents that track mastery, adapt difficulty, and ask probing questions. This is the differentiator.

---

### Phase 5: Production Hardening (Week 8) 🚀

#### 5A. CI/CD (1 day)
- `.github/workflows/deploy.yml`: lint → test → build Docker → push to Azure Container Registry
- Files: `.github/workflows/deploy.yml`

#### 5B. Certificate Generation (1 day)
- PDFKit, upload to Azure Blob → SAS URL → send via WhatsApp
- Reference: `ekatra-whatsapp/certificate.js`
- Files: `services/certificateService.ts`

#### 5C. Monitoring (1 day)
- Azure Application Insights
- Alert on cost spike or error rate >5%
- Files: `lib/monitoring.ts`

#### 5D. Load Testing (1 day)
- 500 concurrent learners with k6/Artillery
- Validate DB connection pooling, Redis throughput

---

### Phase 6: Voice & Multi-Modal (Weeks 9-10)

- Wire up existing Whisper config for voice transcription
- GPT-4o Vision for image-based questions  
- Azure Speech TTS for audio lesson delivery

---

### Phase 7: Offline + Maya Integration (Future)

- Sync protocol between ekatra-platform and Maya Android app
- Offline course packaging
- Periodic sync on connectivity

---

## TIMELINE SUMMARY

| Phase | Duration | Milestone |
|-------|----------|-----------|
| **Phase 1: Ship to Learners** | ✅ Week 1 | WhatsApp bot generates & delivers AI courses |
| **Phase 2: Resource Efficiency** | Weeks 2-3 | Cost <$0.80/learner, dedup, cache, RAG |
| **Phase 3: Spaced Repetition** | Week 4 | FSRS flashcards driving retention |
| **Phase 4: Multi-Agent** | Weeks 5-7 | Adaptive intelligent tutoring |
| **Phase 5: Production** | Week 8 | CI/CD, certificates, monitoring |
| **Phase 6: Voice** | Weeks 9-10 | Multi-modal learning |
| **Phase 7: Offline** | Future | Maya + offline sync |

---

## KEY TECHNICAL DECISIONS

| Decision | Choice | Reason |
|----------|--------|--------|
| Primary codebase | ekatra-platform | Cleaner architecture, TypeScript, better DB |
| AI provider | Azure OpenAI (GPT-4o + GPT-4o-mini) | Already configured, predictable cost |
| Messaging | WhatsApp Cloud API | Direct, cheaper than Twilio |
| Database | PostgreSQL + pgvector | Handles RAG without extra infra |
| Agents | TypeScript (not Python/CrewAI) | Single language stack |
| Hosting | Azure App Service | Already deployed at $18/month |

## RESOURCE BUDGET TARGETS

| Stage | Cost/Learner | Driver |
|-------|-------------|--------|
| Today (Phase 1) | ~$2.50 | GPT-4o for everything |
| After Phase 2 | <$0.80 | Model routing + cache + dedup |
| At scale (1K+ learners) | <$0.40 | Cache hit rate 70%+ |

## KEY RISKS

| Risk | Mitigation |
|------|------------|
| GPT-4o costs spike | Phase 2 model routing + semantic cache (60-70% reduction target) |
| Course generation quality | JSON schema validation + retry + human review dashboard |
| WhatsApp rate limits | Existing rate limiting middleware, batch sends via scheduler |
| Agent complexity → Python | Start TS, migrate only if TypeScript agents prove insufficient |

## PATTERNS TO PORT FROM EKATRA-WHATSAPP

1. **FSM pattern** from `flows/courseFlow.js` → already done in `conversationFSM.ts`
2. **Course generation prompts** from `llama.js` → done in `courseGenerator.ts`
3. **Certificate layout** from `certificate.js` → Phase 5 `certificateService.ts`
4. **Daily reminder cron** → already in platform's `SchedulerService`

## PHASE 1 VERIFICATION

Text the WhatsApp number: "teach me about photosynthesis."
Expected: Receive generated course → daily lessons → doubt via Q&A → completion.
Admin dashboard shows progress in real-time.
