import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDueAt, scheduleRunKey } from '../services/scheduleTiming.js';

const at = (iso: string) => new Date(iso);

test('send_time is matched in the schedule timezone, not the process clock', () => {
  const schedule = { id: 's1', send_time: '09:00', days_of_week: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' };
  // Wed 09:00 IST == 03:30 UTC (the hourly IST cron tick)
  assert.deepEqual(scheduleDueAt(schedule, at('2026-09-30T03:30:00Z')), { localDate: '2026-09-30', lagMinutes: 0 });
  // One minute before send_time is not due
  assert.equal(scheduleDueAt(schedule, at('2026-09-30T03:29:00Z')), null);
  // Same schedule stored as UTC fires at 09:00 UTC
  assert.ok(scheduleDueAt({ ...schedule, timezone: 'UTC' }, at('2026-09-30T09:00:00Z')));
  assert.equal(scheduleDueAt({ ...schedule, timezone: 'UTC' }, at('2026-09-30T03:30:00Z')), null);
});

test('tolerant window: non-:00 send times and late checks still match', () => {
  const schedule = { id: 's1', send_time: '14:30', days_of_week: [3], timezone: 'Asia/Kolkata' };
  // The 15:00 IST tick picks up a 14:30 send_time
  assert.deepEqual(scheduleDueAt(schedule, at('2026-09-30T09:30:00Z')), { localDate: '2026-09-30', lagMinutes: 30 });
  // Outside the window
  assert.equal(scheduleDueAt(schedule, at('2026-09-30T13:30:00Z')), null);
});

test('days_of_week accepts Sunday as 0 or 7 and excludes other days', () => {
  const sundayTick = at('2026-10-04T03:30:00Z'); // Sun 09:00 IST
  assert.ok(scheduleDueAt({ id: 'a', send_time: '09:00', days_of_week: [0], timezone: 'Asia/Kolkata' }, sundayTick));
  assert.ok(scheduleDueAt({ id: 'b', send_time: '09:00', days_of_week: [7], timezone: 'Asia/Kolkata' }, sundayTick));
  assert.equal(scheduleDueAt({ id: 'c', send_time: '09:00', days_of_week: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' }, sundayTick), null);
});

test('a late-night send matched after midnight belongs to the previous local day', () => {
  const schedule = { id: 's1', send_time: '23:30', days_of_week: [3], timezone: 'Asia/Kolkata' };
  // Thu 00:00 IST check, send_time was Wed 23:30
  assert.deepEqual(scheduleDueAt(schedule, at('2026-09-30T18:30:00Z')), { localDate: '2026-09-30', lagMinutes: 30 });
});

test('missing or invalid timezone defaults to Asia/Kolkata', () => {
  const tick = at('2026-09-30T03:30:00Z');
  assert.ok(scheduleDueAt({ id: 'a', send_time: '09:00', days_of_week: [3] }, tick));
  assert.ok(scheduleDueAt({ id: 'b', send_time: '09:00', days_of_week: [3], timezone: 'Not/AZone' }, tick));
  assert.equal(scheduleRunKey('a', '2026-09-30'), 'schedule-run:a:2026-09-30');
});
