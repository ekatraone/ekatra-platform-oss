/**
 * BullMQ processor — Scheduled Push / Hourly Schedule Check
 *
 * Handles two job types on the "scheduled-push" queue:
 *
 *  - daily-push           → run executeScheduledPushes() for all active schedules
 *  - custom-schedule-check → run checkCustomSchedules() for time-matched schedules
 *
 * The processor runs in a separate worker process, so it never blocks the HTTP server.
 * Distributed dedup is enforced by BullMQ jobId uniqueness + Redis lock in the
 * scheduler service.
 */

import { Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { db, initializeDatabase } from '@ekatra/database';

export interface ScheduledPushPayload {
  scheduleId: string;
  scheduleName: string;
}

// Lazy singleton — CourseDeliveryService is heavyweight, only instantiate once
let courseDelivery: any | null = null;

async function getCourseDelivery() {
  if (!courseDelivery) {
    // Resolve via monorepo-relative path: worker/src/jobs/ → backend/src/services/
    // Works in both tsx (dev) and compiled JS (dist) because the layout is mirrored.
    const { CourseDeliveryService } = await import(
      '../../../backend/src/services/courseDelivery.js'
    );
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

  if (scheduleId === 'all') {
    // Daily 9 AM push — execute all active schedules
    const schedules = await db.schedules.findActive();
    let totalSent = 0;
    let totalFailed = 0;

    for (const schedule of schedules) {
      try {
        const delivery = await getCourseDelivery();
        const result = await delivery.executeSchedule(schedule.id);
        totalSent += result.sent;
        totalFailed += result.failed;
        logger.info(`[worker] Schedule "${schedule.name}" done — sent=${result.sent} failed=${result.failed}`);
      } catch (err) {
        logger.error(`[worker] Schedule "${schedule.id}" failed:`, err);
        totalFailed++;
      }
    }

    logger.info(`[worker] Daily push complete — sent=${totalSent} failed=${totalFailed} duration=${Date.now() - start}ms`);
    await job.updateProgress(100);

  } else if (scheduleId === 'check') {
    // Hourly check — run time-matched custom schedules
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDay = now.getDay();

    const schedules = await db.schedules.findActive();

    for (const schedule of schedules) {
      const [scheduleHour, scheduleMinute] = schedule.send_time.split(':').map(Number);
      const daysOfWeek: number[] = schedule.days_of_week || [1, 2, 3, 4, 5];

      if (
        currentHour === scheduleHour &&
        currentMinute === scheduleMinute &&
        daysOfWeek.includes(currentDay)
      ) {
        try {
          const delivery = await getCourseDelivery();
          const result = await delivery.executeSchedule(schedule.id);
          logger.info(`[worker] Custom schedule "${schedule.name}" done — sent=${result.sent} failed=${result.failed}`);
        } catch (err) {
          logger.error(`[worker] Custom schedule "${schedule.id}" failed:`, err);
        }
      }
    }

    logger.info(`[worker] Hourly check complete — duration=${Date.now() - start}ms`);

  } else {
    // Single specific schedule (e.g. manually triggered via API)
    const delivery = await getCourseDelivery();
    const result = await delivery.executeSchedule(scheduleId);
    logger.info(`[worker] Single schedule "${scheduleId}" done — sent=${result.sent} failed=${result.failed}`);
    await job.updateProgress(100);
  }
}
