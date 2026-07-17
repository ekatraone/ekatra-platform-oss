/**
 * BullMQ processor — Flashcard Reminder
 *
 * Sends daily flashcard review reminders to all active learners
 * who have due cards. Redis-backed dedup ensures each learner
 * receives at most one reminder per calendar day, even if the
 * job is retried or the worker restarts.
 */

import { Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { db, initializeDatabase } from '@ekatra/database';
import { messaging, TWILIO_TEMPLATES } from '@ekatra/messaging';
import { getRedis } from '../lib/redis.js';

export interface FlashcardReminderPayload {
  date: string; // "YYYY-MM-DD" — idempotency key
}

async function retryAsync<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

export async function processFlashcardReminder(job: Job<FlashcardReminderPayload>): Promise<void> {
  const { date } = job.data;
  const redis = getRedis();

  logger.info(`[worker] Flashcard reminder job ${job.id} — date=${date}`);
  const start = Date.now();

  if (!db) {
    initializeDatabase();
  }

  const { data: learners } = await db.learners.findAll({ status: 'active', limit: 5000 });

  let total = 0;
  let success = 0;
  let failed = 0;

  for (const learner of learners) {
    // Per-learner dedup via Redis
    const perLearnerKey = `reminded:${date}:${learner.id}`;
    if (redis) {
      const alreadySent = await redis.exists(perLearnerKey);
      if (alreadySent) continue;
    }

    try {
      const dueCount = await db.flashcardProgress.countDueForLearner(learner.id);
      if (dueCount === 0) continue;

      total++;

      // Mark before send — prevents resend if worker is killed mid-loop
      if (redis) {
        await redis.set(perLearnerKey, '1', 'EX', 86400);
      }

      const result = await retryAsync(() =>
        messaging.sendTemplate(learner.phone, TWILIO_TEMPLATES.daily_reminder, {
          '1': learner.name || 'there',
          '2': String(dueCount),
          '3': `flashcard${dueCount !== 1 ? 's' : ''} due for review`,
        })
      );

      if (!result.success) {
        await retryAsync(() =>
          messaging.sendInteractiveButtons(learner.phone, {
            body: `🃏 *Daily Review Reminder*\n\nYou have *${dueCount} flashcard${dueCount !== 1 ? 's' : ''}* due for review today!`,
            buttons: [
              { id: 'review_flashcards', title: `Review ${dueCount} Card${dueCount !== 1 ? 's' : ''}` },
              { id: 'next', title: 'Continue Lesson' },
            ],
          })
        );
      }

      success++;
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[worker] Flashcard reminder failed for learner ${learner.id}:`, err);
      try {
        await db.failedMessages.log({
          learnerId: learner.id,
          phone: learner.phone,
          messageType: 'flashcard_reminder',
          payload: { date },
          errorMessage: errMsg,
          attempts: 3,
        });
      } catch (dlqErr) {
        logger.error('[worker] Failed to write to dead-letter queue:', dlqErr);
      }
    }

    // Update job progress periodically
    if (total % 50 === 0) {
      await job.updateProgress(Math.round((total / learners.length) * 100));
    }
  }

  logger.info(`[worker] Flashcard reminders done — total=${total} success=${success} failed=${failed} duration=${Date.now() - start}ms`);

  if (total > 0 && failed / total > 0.1) {
    logger.error('[worker] HIGH FAILURE RATE on flashcard reminders', { total, success, failed });
  }
}
