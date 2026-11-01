# Contributing

Thanks for helping. This is a TypeScript pnpm monorepo; start with the [README](README.md) quick start and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Workflow

1. Fork and branch from `main`.
2. Make a focused change: one concern per pull request, small commits.
3. Add or update tests next to the code (`__tests__` folders; the suites use Node's built-in test runner).
4. Run `pnpm build` and `pnpm test` before opening a pull request. CI runs the same.
5. Describe what changed and why, and how you verified it.

## Guidelines

- **Channel-agnostic logic.** Business logic must not depend on WhatsApp or Telegram specifics; put those in `packages/messaging` providers or the formatter.
- **Migrations.** Add a new SQL file in `packages/database/src/migrations` numbered after the latest one, and make it idempotent. Never edit a migration that has shipped.
- **Idempotency and retries.** Webhook handlers and queue jobs can run twice; make them safe to repeat. Mark non-retryable send failures as permanent.
- **Secrets.** Never commit `.env` files, tokens, service accounts or real phone numbers. Use placeholders in docs and examples.
- **Style.** Match the surrounding code: naming, comment density, and error handling.

## Reporting bugs

Open an issue with steps to reproduce, expected and actual behaviour, and relevant logs with secrets removed.
