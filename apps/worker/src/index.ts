/**
 * Ekatra Worker Process
 *
 * Consumes BullMQ queues and processes background jobs:
 *  - scheduled-push       → course delivery + schedule checks
 *  - flashcard-reminder   → daily review reminders (Redis-deduped)
 *
 * One process. Restartable. Safe to run alongside multiple backend replicas
 * because distributed locks prevent duplicate processing.
 */

import 'dotenv/config';
import { Worker, QueueEvents } from 'bullmq';
import { logger } from './lib/logger.js';
import { getRedis } from './lib/redis.js';
import { processScheduledPush, type ScheduledPushPayload } from './jobs/scheduledPush.js';
import { processFlashcardReminder, type FlashcardReminderPayload } from './jobs/flashcardReminder.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  logger.error('FATAL: REDIS_URL is required for the worker process');
  process.exit(1);
}

const connection = { url: REDIS_URL };

// ── Scheduled Push Worker ─────────────────────────────────────────────────

const scheduledPushWorker = new Worker<ScheduledPushPayload>(
  'scheduled-push',
  async (job) => {
    await processScheduledPush(job);
  },
  {
    connection,
    concurrency: 1,           // One delivery job at a time — WhatsApp rate limits
    lockDuration: 3_600_000,  // 1h lock; daily push can take 20-30 min for large cohorts
  }
);

scheduledPushWorker.on('completed', (job) => {
  logger.info(`[worker] scheduled-push ${job.id} completed`);
});

scheduledPushWorker.on('failed', (job, err) => {
  logger.error(`[worker] scheduled-push ${job?.id} failed:`, err);
});

// ── Flashcard Reminder Worker ─────────────────────────────────────────────

const flashcardWorker = new Worker<FlashcardReminderPayload>(
  'flashcard-reminder',
  async (job) => {
    await processFlashcardReminder(job);
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 1_800_000, // 30 min
  }
);

flashcardWorker.on('completed', (job) => {
  logger.info(`[worker] flashcard-reminder ${job.id} completed`);
});

flashcardWorker.on('failed', (job, err) => {
  logger.error(`[worker] flashcard-reminder ${job?.id} failed:`, err);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown() {
  logger.info('[worker] Shutting down gracefully...');
  await scheduledPushWorker.close();
  await flashcardWorker.close();
  const redis = getRedis();
  if (redis) await redis.quit();
  logger.info('[worker] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('[worker] Ekatra Worker started. Listening for jobs...');
logger.info(`[worker] REDIS_URL: ${REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
