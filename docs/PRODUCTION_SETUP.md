# Production release setup and verification

Updated 15 September 2026. This guide describes the current source baseline. Deployment inventory and live acceptance are still required before release.

## Toolchain and clean build

Use Node 22.18.0 and pnpm 10.28.1, matching `.nvmrc`, `packageManager`, CI and Docker.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`pnpm build` builds database, messaging, shared delivery, API, worker and frontend in dependency order. Frontend builds now include TypeScript validation. `pnpm test` runs course compiler, configuration, delivery-result, authentication, webhook-signature, readiness and course-mapping tests. Database integration tests require an explicitly supplied `TEST_POSTGRES_URL` or `TEST_POSTGRES_SOCKET`; they never read application `DATABASE_URL`. CI supplies a disposable PostgreSQL service.

Full lint is not yet a passing release gate: frontend has a recorded backlog, and backend's legacy lint script lacks an installed/configured ESLint toolchain. Do not describe the release as lint-clean.

## Configuration

Copy `.env.example` to an untracked `.env` and fill in real values through the environment owner. API and worker load the workspace-root file for local development. Keep secrets out of Git and image build arguments.

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | API, worker and migration connection |
| `REDIS_URL` | Required in production and for every worker process |
| `JWT_SECRET` | API only; random secret with at least 32 characters in production |
| `WHATSAPP_PROVIDER` | `cloudapi` or existing `twilio`; if absent, legacy Twilio precedence is preserved |
| `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` | Required for selected Cloud API |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Required for production Cloud API ingress |
| `WEBHOOK_RECOVERY_INTERVAL_MS` | Optional durable-receipt recovery interval; defaults to 15 seconds and is bounded to at least 5 seconds |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` | Required for selected Twilio |
| `WEBHOOK_BASE_URL` | Public API origin for callbacks; Railway domain can supply the fallback |
| `FRONTEND_URL` | Allowed browser origin |
| `VITE_API_URL` | Frontend build argument; changing runtime environment alone cannot change the built UI |
| `DATABASE_DISABLE_SSL=true` | Only for isolated local PostgreSQL without TLS |

GramIQ is a target integration in the larger scope; no GramIQ adapter is implemented in this batch. Telegram remains available when already configured. Webhook mode requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`; polling mode does not expose Telegram webhook processing. WATI compatibility ingress is off unless a `WATI_WEBHOOK_SECRET` is explicitly set and supplied in `X-Webhook-Secret`.

### Webhook recovery operations

Cloud API receipts that fail processing are retried automatically with bounded
exponential backoff. A `super_admin` can inspect failures through
`GET /api/admin/webhook-receipts/failed` and request a controlled retry through
`POST /api/admin/webhook-receipts/:id/replay`. API responses exclude stored
provider payloads. Replay records the requesting user and time; use it only
after the reported cause has been corrected.

### Certificate links

Certificate downloads use a capability URL containing a randomly generated
token. Requests containing only a learner UUID return `404`. Certificates
issued before this control was added must be regenerated through the normal
completion flow before their links will work. Treat the full URL as learner
data and avoid placing it in public logs or analytics.

## Local services

For isolated local development, start PostgreSQL and Redis, configure `.env`, and apply migrations before starting API and worker:

```sh
docker compose up -d postgres redis
# Export DATABASE_URL and DATABASE_DISABLE_SSL for the isolated local database.
pnpm db:migrate
pnpm dev
# Separate terminals:
pnpm --filter @ekatra/worker dev
pnpm dev:frontend
```

The complete Compose stack includes a one-shot migration service and requires it to finish successfully before API or worker startup. Compose uses the `META_*` variable names read by the application and passes the frontend API URL at build time. Existing volumes without a migration ledger intentionally require reconciliation before upgrade.

## Migration policy

- SQL files use their complete filenames as identities, in lexical order. Both historical `004_*` files remain distinct; do not rename applied files.
- The runner takes a PostgreSQL advisory lock, records SHA-256 checksums in `public.schema_migrations`, and wraps each migration and ledger insert in one transaction.
- Changed/missing applied files, newly inserted files before the applied sequence, and SQL failures stop the run with a nonzero exit status. Errors are not treated as successful migrations.
- Historical `002_seed_data.sql` is excluded from automatic application. Demo users, phone numbers and content must not be seeded into production implicitly.
- Existing schemas without a ledger are refused. Inventory actual tables/columns/indexes on an isolated restored copy, reconcile each historical migration, and review the ledger baseline with the database owner. This batch does not provide automatic adoption or claim an existing-schema upgrade is verified.
- Builds copy SQL into `packages/database/dist/migrations` so the compiled migration command works in deployment bundles.

## Packaging and runtime checks

API and worker Dockerfiles package declared production dependencies using `pnpm deploy --legacy --prod`. They run as the non-root `node` user. The worker imports `@ekatra/delivery`, never backend source. Backend re-export modules preserve existing internal imports.

- `/health` and `/health/live` are liveness endpoints.
- `/health/ready` checks PostgreSQL and Redis concurrently with bounded response time; optional AI and unused provider accounts do not affect readiness.
- `/health/dashboard` and `/health/test-whatsapp` require a super-admin token. Test sending is rate-limited and reports provider rejection as failure.
- Only the selected WhatsApp ingress is active. Meta signatures are verified against original request bytes, not reserialized JSON. Deployments must configure verification secrets before rollout.
- Scheduled job failures are visible as failures. Whole-batch automatic replay is not safe until per-recipient durable delivery records are implemented; do not enable blanket retries to hide this gap.

## Evidence and remaining gates

See the workspace [hardening progress record](../../../docs/planning/HARDENING_PROGRESS.md) and [developer SOW](../../../docs/planning/DEVELOPER_SOW.md). Clean-source builds and local regression tests are recorded there. Container execution, full pgvector schema installation, reviewed upgrade baseline, restore/rollback, load acceptance and real-provider smoke tests remain required.
