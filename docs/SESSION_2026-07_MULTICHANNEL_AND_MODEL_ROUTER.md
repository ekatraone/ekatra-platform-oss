# Multi-channel messaging + model router (2026-07)

What changed, why, and what's still open — for whoever picks this up next.

## Telegram as a second channel

The platform was WhatsApp-only. Added Telegram as a fully equivalent second channel, sharing all business logic:

- `packages/messaging` gained a `TelegramProvider` implementing the same interface as the WhatsApp/Twilio providers (text, images, documents, inline-keyboard buttons and lists). Recipients are addressed as `tg:<chat_id>`; `providerFor(to)` in `packages/messaging/src/index.ts` routes each send to the right provider based on that prefix. WhatsApp learners are untouched.
- `apps/backend/src/services/telegramGateway.ts` maps Telegram updates (`message`, `callback_query`) into the same `MessageHandler.handle()` call WhatsApp webhooks use — `/start` maps to `"hi"` (the FSM's greeting keyword), callback data maps to `buttonReplyId`/`listReplyId`.
- Two ingestion modes: a webhook (`POST /api/webhooks/telegram`, for production) and long-polling (`TELEGRAM_POLLING=true`) for local dev without a public URL.

**Gotcha:** Telegram's `allowed_updates` filter on `getUpdates` persists server-side from whatever was last requested (including by a webhook `setWebhook` call made months earlier). If you don't explicitly pass `allowed_updates=["message","callback_query"]` on every poll, button taps silently vanish — this looked exactly like "the buttons don't work" from the user's side, with no error anywhere.

## Model router

`apps/backend/src/lib/modelRouter.ts` — the Azure AI resource backing this project (`ekatra-bots.services.ai.azure.com`) turned out to have ~20 deployments already provisioned: text models at several tiers, an image model (`gpt-image-1`), a transcription model, and Azure's own `model-router` deployment (auto-picks the cheapest capable model per request). Built one entrypoint that routes by task (`chat`, `generateImage`, `generateSpeech`, `transcribe`, `generateVideo`) with a `capabilities()` check so callers degrade gracefully instead of crashing when something isn't deployed (speech and video are stubbed — no working Azure Speech key or video deployment yet).

`apps/backend/src/lib/llm.ts` sits in front of this for the two existing AI features (course generation, Q&A): prefers `AZURE_ANTHROPIC_API_KEY` if set, falls back to the model router's Azure OpenAI path. Neither course generation nor Q&A needed to change their calling code — they now just work regardless of which credential is configured.

**Gotcha (cost real debugging time twice):** reasoning-class deployments (`gpt-5*`, `o1`, etc., and anything Azure's `model-router` might pick) spend part of `max_completion_tokens` on hidden reasoning *before* emitting visible content. Too small a budget returns **empty content with no error** — it looks like a parsing bug downstream (`JSON.parse('')` → `Unexpected end of JSON input`), not a token-budget problem. Fixed by sizing budgets generously (2000+ for short structured replies, 8000 for full course generation) rather than by "how many words do I actually need."

**Gotcha (masked the above for a while):** `logger.error(message, error)` was calling `JSON.stringify(error)` on native `Error` objects, which always serializes to `{}` — `message`/`stack` are non-enumerable properties. Every error in the app had been logging as `{}` since day one. Fixed in `apps/backend/src/lib/logger.ts` by pulling `message`/`stack` into a plain object before redaction/stringification. Worth checking this didn't regress if the logger changes again.

## Multimodal lesson delivery

`apps/backend/src/services/courseDelivery.ts` — `sendNextLesson()` (the single delivery path both channels already used) now generates an AI illustration per lesson via the model router, using a content-aware prompt (`buildIllustrationPrompt()` — includes an actual snippet of the lesson content, not just the title, since title-only prompts produced generic, interchangeable art).

**Concurrency gotcha (found via live testing, not code review):** the illustration call takes ~15-20s. It originally sat *before* the quiz/"Next Module" button in the send sequence, inside the per-learner Redis lock (`acquireLearnerLock`) that serializes a learner's messages. That meant: the button the learner needed to act on didn't appear for ~20s, and any tap during that window hit the held lock and was **silently dropped** — no reply, no error, nothing. Looked exactly like "the buttons are broken" from outside. Fixed two ways:
1. Reordered: button/quiz sends first (fast — under a second), illustration fires after, not awaited within the critical section.
2. When a tap *does* land on a held lock (still possible — FSM processing isn't instant), the learner now gets a one-time "⏳ Still working on your last message" notice instead of silence, rate-limited to once per 8s so spam-tapping doesn't flood the chat (`apps/backend/src/services/messageHandler.ts`).

Verified live end-to-end via a real Telegram bot, twice in a row: lesson → illustration → quiz → wrong-answer feedback → Next Module tap → lesson 2 (new illustration) → quiz. Then verified the concurrency fix by firing two taps ~400ms apart on a real lesson transition: first acknowledged in ~340ms, second (lock still held) got the busy notice in ~230ms.

## Known gaps / next steps

- **WhatsApp doesn't get illustrations yet.** `sendImageBuffer`/`sendVoiceBuffer`/`sendVideoBuffer` in `packages/messaging` are Telegram-only — Telegram accepts a raw multipart image upload, WhatsApp requires going through Meta's separate media-upload API first (upload → get a media ID → reference it in the message). That's a defined, scoped next task, not started.
- **Audio narration** is built (`modelRouter.generateSpeech`) but not live — `AZURE_SPEECH_KEY` in the shared `.env` returns 401. Either refresh that key or deploy a TTS-capable model on the same Azure resource.
- **Video** has no deployment at all yet (`modelRouter.generateVideo` throws with a clear message telling you what env var to set once one exists — e.g. a `sora` deployment + `AZURE_VIDEO_DEPLOYMENT`).
- No "jump to next lesson" command exists outside of tapping the button — typing free text while mid-course is *always* interpreted as a new course topic request. This caused a confusing bug during testing (typing "next" as a message, not a button tap, kicked off generating a course literally titled "next"). Worth a small FSM guard if that's a real usage pattern, not just a testing artifact.
