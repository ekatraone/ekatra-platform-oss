/**
 * Scheduler Service
 * 
 * Manages scheduled course pushes and daily flashcard review reminders.
 * Uses lazy imports to avoid circular dependencies.
 */

import { logger } from '../lib/logger.js';
import { acquireLock, releaseLock, getRedis } from '../lib/redis.js';
import { sendAlert } from '../lib/alerts.js';

// Retry a function up to maxAttempts times with exponential backoff
async function retryAsync<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000,
): Promise<T> {
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

// Lazy imports
const getDb = () => import('@ekatra/database').then(m => m.db);
const getMessaging = () => import('@ekatra/messaging').then(m => m.messaging);
const getTemplates = () => import('@ekatra/messaging').then(m => m.TWILIO_TEMPLATES);

// NOTE: per-learner reminder dedup is now Redis-backed (see checkFlashcardReminders).
// These in-memory vars are kept only as a fallback when Redis is unavailable.
const flashcardReminderSentToday = new Set<string>();
let lastReminderDate = new Date().toDateString();

export class SchedulerService {
  private courseDelivery: any = null;
  private checkInterval: NodeJS.Timeout | null = null;

  private async getCourseDelivery() {
    if (!this.courseDelivery) {
      const { CourseDeliveryService } = await import('./courseDelivery.js');
      this.courseDelivery = new CourseDeliveryService();
    }
    return this.courseDelivery;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    logger.info('📅 Starting scheduler...');
    
    // Check every minute
    this.checkInterval = setInterval(() => {
      this.checkSchedules().catch(err => {
        logger.error('Scheduler error:', err);
      });
    }, 60000);

    // Run immediately on start
    this.checkSchedules().catch(err => {
      logger.error('Initial scheduler check error:', err);
    });
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Scheduler stopped');
    }
  }

  /**
   * Check all active schedules and execute if it's time
   */
  private async checkSchedules(): Promise<void> {
    const db = await getDb();
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDay = now.getDay(); // 0 = Sunday

    // Get all active schedules
    const schedules = await db.schedules.findActive();

    for (const schedule of schedules) {
      try {
        // Parse schedule time (format: "HH:MM")
        const [scheduleHour, scheduleMinute] = schedule.send_time.split(':').map(Number);
        
        // Check if it's the right time (within 1 minute window)
        if (currentHour === scheduleHour && currentMinute === scheduleMinute) {
          // Check if it's the right day
          const daysOfWeek = schedule.days_of_week || [1, 2, 3, 4, 5]; // Default weekdays
          if (daysOfWeek.includes(currentDay)) {
            logger.info(`Executing schedule: ${schedule.name}`);
            
            const courseDelivery = await this.getCourseDelivery();
            await courseDelivery.executeSchedule(schedule.id);
          }
        }
      } catch (error) {
        logger.error(`Error checking schedule ${schedule.id}:`, error);
      }
    }

    // Flashcard review reminders — send once daily at 9:00 AM
    await this.checkFlashcardReminders(currentHour, currentMinute);
  }

  /**
   * Send flashcard review reminders to learners who have due cards.
   * Fires once per day at 09:00 (server local time).
   *
   * Distributed-safe: uses a Redis lock so only ONE replica sends reminders
   * even when running multiple backend instances.
   */
  private async checkFlashcardReminders(currentHour: number, currentMinute: number): Promise<void> {
    const REMINDER_HOUR = 9;
    if (currentHour !== REMINDER_HOUR || currentMinute !== 0) return;

    const today = new Date().toISOString().slice(0, 10); // "2026-04-06"

    // Acquire distributed lock — only one replica runs this per day
    const lockKey = `daily-reminder:${today}`;
    const hasLock = await acquireLock(lockKey, 3600); // 1h TTL
    if (!hasLock) {
      logger.info(`⏭️  Flashcard reminder lock held by another instance — skipping (${lockKey})`);
      return;
    }

    // Reset in-memory fallback set for new day
    if (today !== lastReminderDate) {
      flashcardReminderSentToday.clear();
      lastReminderDate = today;
    }

    try {
      const db = await getDb();
      const messaging = await getMessaging();
      const TEMPLATES = await getTemplates();

      // Find all active learners
      const { data: learners } = await db.learners.findAll({ status: 'active', limit: 500 });

      let total = 0;
      let success = 0;
      let failed = 0;

      const redis = getRedis();

      for (const learner of learners) {
        // Per-learner dedup: Redis-backed when available, in-memory fallback
        const perLearnerKey = `reminded:${today}:${learner.id}`;
        if (redis) {
          const alreadySent = await redis.exists(perLearnerKey);
          if (alreadySent) continue;
        } else if (flashcardReminderSentToday.has(learner.id)) {
          continue;
        }

        try {
          const dueCount = await db.flashcardProgress.countDueForLearner(learner.id);
          if (dueCount === 0) continue;

          total++;
          // Mark as processing before the send attempt — prevents double-send on retry
          if (redis) {
            await redis.set(perLearnerKey, '1', 'EX', 86400);
          } else {
            flashcardReminderSentToday.add(learner.id);
          }

          // Use pre-approved template — works outside the 24hr WhatsApp session window
          // daily_reminder vars: {1: name, 2: due count, 3: "flashcard review"}
          const result = await retryAsync(() => messaging.sendTemplate(
            learner.phone,
            TEMPLATES.daily_reminder,
            {
              '1': learner.name || 'there',
              '2': String(dueCount),
              '3': 'flashcard review',
            },
          ));

          // Fall back to interactive buttons if template fails (e.g. non-Twilio provider)
          if (!result.success) {
            await retryAsync(() => messaging.sendInteractiveButtons(learner.phone, {
              body: `🃏 *Daily Review Reminder*\n\nYou have *${dueCount} flashcard${dueCount !== 1 ? 's' : ''}* due for review today!\n\nSpaced repetition keeps knowledge fresh — just takes a few minutes.`,
              buttons: [
                { id: 'review_flashcards', title: `Review ${dueCount} Card${dueCount !== 1 ? 's' : ''}` },
                { id: 'next', title: 'Continue Lesson' },
              ],
            }));
          }

          success++;
          logger.info(`📬 Flashcard reminder sent to ${learner.phone} (${dueCount} due)`);
        } catch (err) {
          failed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Flashcard reminder failed for ${learner.id}:`, err);
          // Dead-letter: persist the failure so ops can inspect/replay
          try {
            await db.failedMessages.log({
              learnerId: learner.id,
              phone: learner.phone,
              messageType: 'flashcard_reminder',
              payload: { dueCount: await db.flashcardProgress.countDueForLearner(learner.id).catch(() => 0), date: today },
              errorMessage: errMsg,
              attempts: 3,
            });
            await sendAlert({
              level: 'warning',
              title: 'Message Added to Dead-Letter Queue',
              message: `Flashcard reminder failed for learner after 3 retries`,
              fields: { learnerId: learner.id, error: errMsg.slice(0, 120) },
            });
          } catch (dlqErr) {
            logger.error('Failed to write to dead-letter queue:', dlqErr);
          }
        }
      }

      logger.info('Daily reminders sent', { total, success, failed });
      if (total > 0 && failed / total > 0.1) {
        const rate = (failed / total * 100).toFixed(0);
        logger.error('HIGH FAILURE RATE on daily reminders', { total, success, failed, rate });
        await sendAlert({
          level: 'critical',
          title: 'Daily Reminder High Failure Rate',
          message: `${rate}% of daily reminders failed (${failed}/${total})`,
          fields: { total, success, failed, rate: `${rate}%`, date: today },
        });
      }

      // Release lock on success so a manual re-run is possible if needed
      await releaseLock(lockKey);
    } catch (err) {
      logger.error('checkFlashcardReminders error:', err);
      // Don't release lock on error — TTL will expire it, preventing retry spam
    }
  }

  /**
   * Execute all active schedules (inline fallback when BullMQ is unavailable).
   */
  async executeScheduledPushes(): Promise<void> {
    const db = await getDb();
    const schedules = await db.schedules.findActive();
    for (const schedule of schedules) {
      try {
        const courseDelivery = await this.getCourseDelivery();
        const result = await courseDelivery.executeSchedule(schedule.id);
        logger.info(`Schedule "${schedule.name}" done — sent=${result.sent} failed=${result.failed}`);
      } catch (err) {
        logger.error(`Schedule "${schedule.id}" failed:`, err);
      }
    }
  }

  /**
   * Check and execute time-matched custom schedules (inline fallback).
   */
  async checkCustomSchedules(): Promise<void> {
    await this.checkSchedules();
  }

  /**
   * Public wrapper so cron inline fallback can call flashcard reminders.
   */
  async sendFlashcardReminders(): Promise<void> {
    await this.checkFlashcardReminders(9, 0);
  }

  /**
   * Execute a specific schedule immediately
   */
  async executeNow(scheduleId: string): Promise<{ sent: number; failed: number }> {
    const courseDelivery = await this.getCourseDelivery();
    return courseDelivery.executeSchedule(scheduleId);
  }

  /**
   * Get upcoming scheduled pushes
   */
  async getUpcoming(hours: number = 24): Promise<any[]> {
    const db = await getDb();
    
    const schedules = await db.schedules.findActive();
    const upcoming: any[] = [];
    const now = new Date();

    for (const schedule of schedules) {
      const enrollments = await db.enrollments.getActiveForCourse(schedule.course_id);
      const [hour, minute] = schedule.send_time.split(':').map(Number);
      
      // Calculate next push time
      const nextPush = new Date();
      nextPush.setHours(hour, minute, 0, 0);
      if (nextPush <= now) {
        nextPush.setDate(nextPush.getDate() + 1);
      }

      if (nextPush.getTime() - now.getTime() < hours * 60 * 60 * 1000) {
        upcoming.push({
          schedule,
          nextPush,
          learnerCount: enrollments.length
        });
      }
    }

    return upcoming.sort((a, b) => a.nextPush.getTime() - b.nextPush.getTime());
  }
}

// Singleton instance
let schedulerInstance: SchedulerService | null = null;

export function getScheduler(): SchedulerService {
  if (!schedulerInstance) {
    schedulerInstance = new SchedulerService();
  }
  return schedulerInstance;
}
