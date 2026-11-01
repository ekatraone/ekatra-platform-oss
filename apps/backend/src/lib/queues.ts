/**
 * BullMQ Queue Definitions
 *
 * Producers (backend) enqueue jobs here.
 * Consumers (worker) process them.
 */

import { Queue } from 'bullmq';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

// ── Queue names ────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  SCHEDULED_PUSH: 'scheduled-push',
  FLASHCARD_REMINDER: 'flashcard-reminder',
} as const;

// ── Job payloads ───────────────────────────────────────────────────────────

export interface ScheduledPushJob {
  scheduleId: string;
  scheduleName: string;
}

export interface FlashcardReminderJob {
  date: string; // ISO date string — used as idempotency key
}

// ── Queue producers — lazy singletons ────────────────────────────────────

let scheduledPushQueue: Queue<ScheduledPushJob> | null = null;
let flashcardReminderQueue: Queue<FlashcardReminderJob> | null = null;

function getConnection() {
  const redis = getRedis();
  if (!redis) return null;
  return redis;
}

export function getScheduledPushQueue(): Queue<ScheduledPushJob> | null {
  if (scheduledPushQueue) return scheduledPushQueue;
  const connection = getConnection();
  if (!connection) return null;
  scheduledPushQueue = new Queue<ScheduledPushJob>(QUEUE_NAMES.SCHEDULED_PUSH, { connection });
  scheduledPushQueue.on('error', (err) => logger.error('ScheduledPushQueue error:', err));
  return scheduledPushQueue;
}

export function getFlashcardReminderQueue(): Queue<FlashcardReminderJob> | null {
  if (flashcardReminderQueue) return flashcardReminderQueue;
  const connection = getConnection();
  if (!connection) return null;
  flashcardReminderQueue = new Queue<FlashcardReminderJob>(QUEUE_NAMES.FLASHCARD_REMINDER, { connection });
  flashcardReminderQueue.on('error', (err) => logger.error('FlashcardReminderQueue error:', err));
  return flashcardReminderQueue;
}
