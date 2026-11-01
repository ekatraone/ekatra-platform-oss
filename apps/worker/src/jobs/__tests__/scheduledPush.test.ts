import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import { db } from '@ekatra/database';
import { CourseDeliveryService } from '@ekatra/delivery';
import { processScheduledPush, type ScheduledPushPayload } from '../scheduledPush.js';

function job(scheduleId: string, timestamp?: number) {
  const progress: number[] = [];
  return {
    progress,
    value: {
      id: 'test-job', data: { scheduleId, scheduleName: 'Test schedule' }, timestamp,
      updateProgress: async (value: number) => { progress.push(value); },
    } as unknown as Job<ScheduledPushPayload>,
  };
}

test('single schedule provider failures reject the job without 100% progress', async t => {
  t.mock.method(CourseDeliveryService.prototype, 'executeSchedule', async () => ({ sent: 2, failed: 1 }));
  const fixture = job('schedule-1');
  await assert.rejects(processScheduledPush(fixture.value), /failed for 1 recipients/);
  assert.deepEqual(fixture.progress, []);
});
test('successful schedule completes progress', async t => {
  t.mock.method(CourseDeliveryService.prototype, 'executeSchedule', async () => ({ sent: 2, failed: 0 }));
  const fixture = job('schedule-1');
  await processScheduledPush(fixture.value);
  assert.deepEqual(fixture.progress, [100]);
});
// Wed 2026-09-30 09:00 IST (03:30 UTC) — the cron tick in Asia/Kolkata.
const WED_0900_IST = Date.parse('2026-09-30T03:30:00Z');

test('daily batch continues other schedules and exposes partial failure', async t => {
  t.mock.method(db.schedules, 'findActive', async () => [{ id: 'bad', name: 'Bad' }, { id: 'good', name: 'Good' }]);
  const calls: string[] = [];
  t.mock.method(CourseDeliveryService.prototype, 'executeSchedule', async (id: string) => {
    calls.push(id);
    if (id === 'bad') throw new Error('test failure');
    return { sent: 1, failed: 0 };
  });
  await assert.rejects(processScheduledPush(job('all', WED_0900_IST).value), /Scheduled delivery failed/);
  assert.deepEqual(calls, ['bad', 'good']);
});
test('schedule check honours send_time/days_of_week in the schedule timezone and runs once per day', async t => {
  const tick = Date.parse('2026-10-01T03:30:00Z'); // Thu 09:00 IST
  t.mock.method(db.schedules, 'findActive', async () => [
    { id: 'thu-morning', name: 'Weekday Morning', send_time: '09:00', days_of_week: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
    { id: 'afternoon', name: 'Daily Afternoon', send_time: '14:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], timezone: 'Asia/Kolkata' },
    { id: 'weekend', name: 'Weekend', send_time: '09:00', days_of_week: [0, 6], timezone: 'Asia/Kolkata' },
    { id: 'half-past', name: 'Half past', send_time: '08:30', days_of_week: [4], timezone: 'Asia/Kolkata' },
  ]);
  const calls: string[] = [];
  t.mock.method(CourseDeliveryService.prototype, 'executeSchedule', async (id: string) => {
    calls.push(id);
    return { sent: 1, failed: 0 };
  });
  // A check job that runs late still matches its enqueue time, not the wall clock.
  await processScheduledPush(job('check', tick).value);
  assert.deepEqual(calls, ['thu-morning', 'half-past']);

  // The next hourly tick (and a legacy 'all' job) must not send them again.
  await processScheduledPush(job('check', tick + 3600_000).value);
  await processScheduledPush(job('all', tick).value);
  assert.deepEqual(calls, ['thu-morning', 'half-past']);
});
