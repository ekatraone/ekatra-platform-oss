# Ekatra Platform (v4)

AI-powered micro-learning delivered through chat — WhatsApp and Telegram today — with AI course generation, a Socratic Q&A tutor, and multimodal lesson content (text + AI-generated illustrations, more media types on the way).

This is a fresh, public export of the platform's codebase. Full commit history (including a period where deployment secrets were accidentally committed) stays in the private origin repo — see [Security](#security--secrets) below.

## What's in here

- **`apps/backend`** — Express API: course/learner/schedule management, WhatsApp + Telegram messaging, the conversation FSM (onboarding → course generation → lesson delivery → quiz → Q&A), auth, analytics.
- **`apps/frontend`** — React + Vite admin dashboard (courses, learners, schedules, analytics, channel config).
- **`apps/worker`** — background job processing.
- **`packages/database`** — Postgres (pgvector) schema, migrations, seed data, typed repositories.
- **`packages/messaging`** — channel-agnostic messaging layer. One `messaging.sendText(to, ...)` call routes to WhatsApp Cloud API, Twilio, or Telegram depending on the recipient address (`tg:<chat_id>` → Telegram; phone number → WhatsApp).
- **`packages/shared`** — shared types/utilities.

## Architecture highlights

**Multi-channel by design.** Learners are addressed by a channel-tagged id (`tg:<chat_id>` for Telegram, a phone number for WhatsApp). The FSM, course delivery, and Q&A code don't know or care which channel a learner is on — `packages/messaging` resolves the right provider per message. Adding a new channel means implementing one provider interface, not touching business logic.

**Model router (`apps/backend/src/lib/modelRouter.ts`).** Task-based routing over an Azure AI resource with many deployments:
- Text: `auto` (Azure's own `model-router` deployment picks the cheapest capable model), `best`, `mini` tiers.
- Image: `gpt-image-1` (OpenAI's image model, via Azure) — lesson illustrations generated from actual lesson content, not just the title.
- Transcribe: `gpt-4o-mini-transcribe`.
- Speech (TTS) and video: interfaces are built; wire up a deployment (Azure Speech key, a video model) and they light up automatically — see `modelRouter.capabilities()`.

`apps/backend/src/lib/llm.ts` provides a simpler `llmChat()` entrypoint used by course generation and Q&A: prefers Anthropic/Claude if configured, falls back to Azure OpenAI.

**Conversation FSM (`apps/backend/src/flows/conversationFSM.ts`).** Explicit state machine (onboarding → topic/goal capture → course generation → lesson delivery → quiz → day-end review → doubt/Q&A loop). Every inbound message — text, button tap, or Telegram callback — funnels through `MessageHandler` → `ConversationFSM.process()`, serialized per-learner via a Redis lock so concurrent messages from the same learner can't race.

**Lesson delivery (`apps/backend/src/services/courseDelivery.ts`).** The single path both channels use to send a lesson: header/progress → content → quiz-or-"Next Module" button (sent first, so the learner can act immediately) → AI illustration (sent after, fire-and-forget, so a slow image generation never blocks the interactive part of the message).

## Local development

**Never point local dev at production.** The committed `.env.example` files are templates only — copy them, fill in your own values, and always override `DATABASE_URL` to a local database when developing:

```bash
pnpm install
cp .env.example .env                                  # fill in your own values
cp apps/backend/.env.example apps/backend/.env

docker compose -f docker-compose.dev.yml up -d         # local Postgres (pgvector) + Redis

# Run migrations against the LOCAL database explicitly
DATABASE_URL='postgresql://ekatra:ekatra_dev_password@localhost:5432/ekatra' \
DATABASE_DISABLE_SSL=true pnpm db:migrate

# Start the backend — override DATABASE_URL and disable real message sends
# for local work unless you specifically intend to hit production channels
set -a; source apps/backend/.env; set +a
DATABASE_URL='postgresql://ekatra:ekatra_dev_password@localhost:5432/ekatra' \
DATABASE_DISABLE_SSL=true \
META_ACCESS_TOKEN='local-dev-disabled' \
pnpm dev

# Frontend (separate terminal)
VITE_API_URL='http://localhost:3001' pnpm --filter @ekatra/frontend dev
```

Seed a local admin user:

```bash
curl -X POST http://localhost:3001/api/auth/seed \
  -H 'Content-Type: application/json' \
  -d '{"seedKey":"<your ADMIN_SEED_KEY>","email":"dev@example.local","password":"...","name":"Local Dev","role":"admin"}'
```

### Testing the Telegram channel without a public URL

Set `TELEGRAM_BOT_TOKEN` (get one from [@BotFather](https://t.me/BotFather)) and `TELEGRAM_POLLING=true` — the backend long-polls Telegram's `getUpdates` API instead of requiring a webhook, so you can test the full onboarding → lesson → quiz flow from a laptop with no tunnel.

### AI features

Course generation and Q&A need one working LLM credential — set `AZURE_ANTHROPIC_API_KEY` (Claude, preferred) or the `AZURE_OPENAI_*` variables. Lesson illustrations additionally need an image-capable deployment (`gpt-image-1` or similar) on the same Azure resource. Everything degrades gracefully without them — `modelRouter.capabilities()` reports what's actually available, and features that need something missing fail with a clear message rather than crashing.

## Security & secrets

- **Never commit `.env` files.** Only `.env.example` (with placeholder values) belongs in git.
- This export deliberately starts with a clean history. An earlier period of the private origin repo had deployment scripts and setup docs with real credentials pasted in as "examples" — those were scrubbed from every currently-tracked file before this export was created, but the *old commits* containing them still exist in the private repo's history. Rotate anything that was ever committed there before treating it as safe.
- `apps/backend/set-azure-env.sh` reads all values from the environment — it never hardcodes credentials. Keep it that way.
- Local dev should always use `DATABASE_DISABLE_SSL=true` + a local Postgres, and `META_ACCESS_TOKEN='local-dev-disabled'` (or similar) unless you specifically intend to send real messages — the cron scheduler starts immediately on boot and will attempt real sends to any WhatsApp-configured learners in whatever database you point it at.

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md) — development workflow notes.
- [docs/](docs/) — planning and architecture notes.
- [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) — WhatsApp Cloud API setup (Meta dashboard walkthrough).
