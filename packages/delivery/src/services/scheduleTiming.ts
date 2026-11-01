/**
 * Schedule timing — decides whether a push schedule is due at a given instant.
 *
 * send_time and days_of_week are interpreted in the schedule's own timezone
 * (Asia/Kolkata when unset/invalid, matching the cron and the admin UI default).
 * Matching uses a tolerant window rather than an exact minute, so an hourly
 * check that runs late (queued behind a long push) or a send_time that is not
 * on :00 still fires. Callers must pair this with a per-schedule, per-local-date
 * run key (see scheduleRunKey) so overlapping checks cannot send twice a day.
 */

export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Kolkata';

/** Two hourly ticks: catches up one missed/late check; the run key prevents repeats. */
export const DEFAULT_SCHEDULE_WINDOW_MINUTES = 120;

export interface ScheduleLike {
  id: string;
  send_time?: string | null;
  days_of_week?: number[] | null;
  timezone?: string | null;
}

export interface DueSchedule {
  /** Local calendar date (YYYY-MM-DD, schedule timezone) the run belongs to. */
  localDate: string;
  /** Minutes between the scheduled send time and the check instant. */
  lagMinutes: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function resolveTimezone(timezone: string | null | undefined): string {
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return timezone;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_SCHEDULE_TIMEZONE;
}

function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0, // 0 = Sunday
  };
}

function parseSendTime(sendTime: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(sendTime || '09:00');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * days_of_week has been stored both as 0-6 (Sun=0, admin UI) and 1-7
 * (Mon=1..Sun=7, seed data) — accept either spelling of Sunday.
 */
function includesWeekday(days: number[], weekday: number): boolean {
  return days.includes(weekday) || (weekday === 0 && days.includes(7));
}

/**
 * Returns the local run date when `schedule` is due at `at` (its send_time fell
 * within the last `windowMinutes`, on an allowed weekday), otherwise null.
 */
export function scheduleDueAt(
  schedule: ScheduleLike,
  at: Date,
  windowMinutes = DEFAULT_SCHEDULE_WINDOW_MINUTES,
): DueSchedule | null {
  const sendMinutes = parseSendTime(schedule.send_time);
  if (sendMinutes === null) return null;
  const timeZone = resolveTimezone(schedule.timezone);

  const now = localParts(at, timeZone);
  const lagMinutes = (now.minutes - sendMinutes + 1440) % 1440;
  if (lagMinutes >= Math.min(windowMinutes, 1440)) return null;

  // The scheduled instant may be on the previous local day (e.g. 23:30 send
  // matched by a 00:00 check) — take date and weekday from that instant.
  const scheduled = localParts(new Date(at.getTime() - lagMinutes * 60_000), timeZone);
  const days = Array.isArray(schedule.days_of_week) ? schedule.days_of_week.map(Number) : [1, 2, 3, 4, 5];
  if (!includesWeekday(days, scheduled.weekday)) return null;

  return { localDate: scheduled.date, lagMinutes };
}

/** Idempotency key: one run per schedule per local date. */
export function scheduleRunKey(scheduleId: string, localDate: string): string {
  return `schedule-run:${scheduleId}:${localDate}`;
}
