/**
 * BullMQ processor — Scheduled Push / Periodic Schedule Check
 *
 * Handles two job types on the "scheduled-push" queue:
 *
 *  - custom-schedule-check → run the schedules due now (send_time/days_of_week in
 *                            the schedule's timezone), at most once per local day
 *  - daily-push (legacy)   → same as custom-schedule-check
 *  - <scheduleId>          → run one schedule immediately (manual trigger)
 *
 * The processor runs in a separate worker process, so it never blocks the HTTP server.
 * Distributed dedup is enforced by BullMQ jobId uniqueness + Redis lock in the
 * scheduler service.
 */

import { Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { db, initializeDatabase } from '@ekatra/database';
import { getRedis } from '../lib/redis.js';

export interface ScheduledPushPayload {
  scheduleId: string;
  scheduleName: string;
  /** ISO time the cron tick fired — schedule matching is evaluated at this instant. */
  firedAt?: string;
}

// In-process fallback for the per-day run key when Redis is not configured.
const localRunKeys = new Set<string>();

/** Claim the once-per-local-day run for a schedule. False if already claimed. */
async function claimScheduleRun(key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (localRunKeys.has(key)) return false;
    localRunKeys.add(key);
    return true;
  }
  return (await redis.set(key, '1', 'EX', 48 * 3600, 'NX')) === 'OK';
}

async function releaseScheduleRun(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    localRunKeys.delete(key);
    return;
  }
  await redis.del(key);
}

async function runDueSchedules(at: Date): Promise<{ totalSent: number; totalFailed: number }> {
  const { scheduleDueAt, scheduleRunKey } = await import('@ekatra/delivery');
  const schedules = await db.schedules.findActive();
  let totalSent = 0;
  let totalFailed = 0;

  for (const schedule of schedules) {
    const due = scheduleDueAt(schedule, at);
    if (!due) continue;

    const runKey = scheduleRunKey(schedule.id, due.localDate);
    if (!(await claimScheduleRun(runKey))) {
      logger.info(`[worker] Schedule "${schedule.name}" already ran for ${due.localDate} — skipping`);
      continue;
    }

    try {
      const delivery = await getCourseDelivery();
      const result = await delivery.executeSchedule(schedule.id);
      totalSent += result.sent;
      totalFailed += result.failed;
      logger.info(`[worker] Schedule "${schedule.name}" done — sent=${result.sent} failed=${result.failed}`);
    } catch (err) {
      // Nothing was confirmed sent — free the day's key so the next check retries.
      await releaseScheduleRun(runKey).catch(() => {});
      logger.error(`[worker] Schedule "${schedule.id}" failed:`, err);
      totalFailed++;
    }
  }
  return { totalSent, totalFailed };
}

// Lazy singleton — CourseDeliveryService is heavyweight, only instantiate once
let courseDelivery: import('@ekatra/delivery').CourseDeliveryService | null = null;

async function getCourseDelivery() {
  if (!courseDelivery) {
    const { CourseDeliveryService } = await import('@ekatra/delivery');
    courseDelivery = new CourseDeliveryService();
  }
  return courseDelivery;
}

export async function processScheduledPush(job: Job<ScheduledPushPayload>): Promise<void> {
  const { scheduleId, scheduleName } = job.data;

  logger.info(`[worker] Starting job ${job.id} — "${scheduleName}"`);
  const start = Date.now();

  // Ensure DB is initialised (worker boot may race ahead of initializeDatabase)
  if (!db) {
    initializeDatabase();
  }

  if (scheduleId === 'all' || scheduleId === 'check') {
    // Schedule check (and legacy 'all' daily jobs still in the queue): run only
    // the schedules whose send_time/days_of_week match in their own timezone.
    // Match against the intended fire time, not the worker's wall clock — the
    // job may have waited behind a long push on this concurrency-1 queue.
    const firedAt = new Date(job.data.firedAt ?? job.timestamp ?? Date.now());
    const { totalSent, totalFailed } = await runDueSchedules(Number.isNaN(firedAt.getTime()) ? new Date() : firedAt);

    logger.info(`[worker] Schedule check complete — sent=${totalSent} failed=${totalFailed} duration=${Date.now() - start}ms`);
    if (totalFailed > 0) throw new Error(`Scheduled delivery failed for ${totalFailed} recipients or schedules`);
    await job.updateProgress(100);

  } else {
    // Single specific schedule (e.g. manually triggered via API)
    const delivery = await getCourseDelivery();
    const result = await delivery.executeSchedule(scheduleId);
    logger.info(`[worker] Single schedule "${scheduleId}" done — sent=${result.sent} failed=${result.failed}`);
    if (result.failed > 0) throw new Error(`Schedule ${scheduleId} failed for ${result.failed} recipients`);
    await job.updateProgress(100);
  }
}
