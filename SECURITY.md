# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), and include steps to reproduce and the impact. We will acknowledge reports and work with you on a fix and disclosure.

## Handling secrets

- Configuration comes from environment variables only. `.env` files are git-ignored.
- `.env.example` contains placeholders; never put real values in it, in docs, or in tests.
- If you deploy this, generate your own `JWT_SECRET` and `ADMIN_SEED_KEY` (long random values), and rotate any credential that was ever pasted into a chat, ticket or commit.

## What the platform enforces

- Webhook signature verification and stored receipts for safe retry.
- Rate limits on API routes, per-learner limits on the sync API, and OTP abuse limits with escalating lockouts.
- Learner tokens are JWTs (24-hour expiry by default) issued after verifying a Firebase ID token server-side.
- Account deletion removes learner data and learner-owned generated courses.
