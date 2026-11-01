# Ekatra Platform

Open-source backend for **AI-assisted micro-learning over chat**. Learners get short lessons, quizzes and a Socratic tutor on WhatsApp and Telegram; educators manage courses, learners and schedules from a web dashboard; Android apps sync lessons for offline use.

This repository is the infrastructure layer: everything you need to run your own deployment, understand how it works, and build on it.

## What it does

- **Multi-channel delivery.** One messaging layer routes to WhatsApp (Meta Cloud API or Twilio) or Telegram. Business logic never knows which channel a learner is on.
- **Conversation engine.** A finite state machine drives onboarding, course selection or AI generation, lesson delivery, quizzes and Q&A. Courses can be authored as state machines and edited visually.
- **AI course generation and tutoring.** A model router picks the right model per task (text tiers, images, speech, transcription) across Azure OpenAI, OpenAI and Anthropic, with a retrieval-backed tutor on pgvector.
- **Scheduling.** Lessons are pushed on each learner's schedule through Redis-backed queues, with retries and a dead-letter path.
- **Spaced repetition.** Flashcards use FSRS scheduling.
- **Mobile sync API.** Learner sign-in via Firebase, course bundles for offline use, progress sync, account deletion.
- **Admin dashboard.** Courses, learners, schedules, analytics, chat history, channel settings, FSM editor.

## Architecture in one picture

```
  WhatsApp / Telegram ──webhooks──┐
  Android apps ──/api/sync (JWT)──┤──►  Backend API (Express) ──► Postgres + pgvector
  Admin dashboard (React) ────────┘            │                       ▲
                                               ├──► Redis ◄── Worker (BullMQ jobs)
                                               └──► Model providers (Azure OpenAI / OpenAI / Anthropic)
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full walkthrough: request paths, the FSM, channels, the model router, scheduling, auth, the sync API contract, and how the Android apps and offline hub fit in.

## Repository layout

```
apps/
  backend/    Express API, conversation FSM, webhooks, schedulers
  frontend/   React + Vite admin dashboard
  worker/     Background jobs (BullMQ)
packages/
  database/   Postgres schema, migrations, repositories, seed
  delivery/   Lesson delivery, schedule timing, certificates, model router
  messaging/  Channel-agnostic send layer
  shared/     Shared types and utilities
docs/         Architecture
scripts/      Setup and dev helpers
```

## Quick start (local)

Requirements: Node 22.18 (see `.nvmrc`), pnpm 10.28, Docker.

```bash
pnpm install
cp .env.example .env            # then fill in values; see Configuration below
pnpm docker:dev                 # Postgres (pgvector) + Redis (+ pgAdmin)
pnpm db:migrate                 # apply SQL migrations
pnpm db:seed                    # optional sample data
pnpm dev:all                    # backend, frontend and worker in watch mode
```

The backend listens on port 3000; health checks are at `/health`. The frontend dev server prints its URL on start. WhatsApp needs credentials for one provider (`WHATSAPP_PROVIDER` is `cloudapi` or `twilio`); Telegram is optional (`TELEGRAM_BOT_TOKEN`).

Create the first admin once with `POST /api/auth/seed`, protected by the `ADMIN_SEED_KEY` you set in `.env`.

Run the tests and a full build:

```bash
pnpm test
pnpm build
```

Or run everything in containers: `docker-compose up -d` (Postgres, Redis, a migration job, backend, frontend and worker; frontend on port 8080).

## Configuration

Everything is environment variables. `.env.example` lists them all with placeholders. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (pgvector required) |
| `REDIS_URL` | Queues and rate limits |
| `JWT_SECRET` | Random string, 32+ characters in production |
| `ADMIN_SEED_KEY` | Guards the one-time admin creation endpoint |
| `WHATSAPP_PROVIDER` | `cloudapi` or `twilio` |
| `META_*` | WhatsApp Cloud API credentials and webhook verification |
| `TWILIO_*` | If using Twilio |
| `TELEGRAM_BOT_TOKEN` | Telegram channel |
| `AZURE_OPENAI_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Model providers (configure at least one) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Verifies Android learner sign-in |
| `FRONTEND_URL`, `WEBHOOK_BASE_URL` | Allowed origin and public callback URL |

Channel setup details are in [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md).

## Deploying

The Dockerfiles in `apps/*` build production images, and `docker-compose.yml` shows the full service topology. Any host that runs containers works (Railway, Render, Fly.io, AWS ECS, a VM). You need: Postgres with the pgvector extension, Redis, and three services (backend, worker, frontend). Run `node node_modules/@ekatra/database/dist/migrate.js` before starting a new backend version; the migration runner refuses to apply a migration numbered before ones already applied, so number new migrations after the latest.

A one-click deploy template is planned.

## Related projects

- **Android apps** (Asmaa and Maya, offline-first with an on-device LLM): sync through this platform's `/api/sync` API. Public repository planned.
- **Offline hub** (Raspberry Pi serving a classroom over local Wi-Fi): public repository planned.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). For security issues see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
