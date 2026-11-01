/**
 * Learner Profile Service (Milestone 13a)
 *
 * Derives a per-learner learning profile from structured learner_events.
 * Deliberately simple math — recency-weighted correct ratios, not BKT
 * (BKT/FSRS is explicitly out of scope until cohort measurement shows lift).
 *
 * Contract:
 *  - recordLearnerEvent() NEVER throws and never blocks message delivery (AC1b).
 *  - computeProfile() is a pure function over an event array — unit-testable
 *    against fixture (dummy) data with pinned expected values (AC1).
 *  - Timezone: learners.timezone schema default is 'UTC'; an unset/'UTC'
 *    value is treated as Asia/Kolkata at read time (pilot cohorts are IST).
 */

import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

// Recency weight per attempt: newest = 1, previous = DECAY, then DECAY^2, …
const DECAY = 0.9;
// A lesson is a "struggle" once it has accumulated this many wrong answers.
const STRUGGLE_WRONG_THRESHOLD = 2;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export interface LearnerEvent {
  type: string; // quiz_answered | lesson_completed | ...
  node_id?: string | null;
  payload?: { correct?: boolean; lesson_id?: string; [k: string]: any } | null;
  created_at: string | Date;
}

export interface LearnerProfileData {
  mastery: Record<string, number>; // lesson key → 0..1
  struggles: string[];
  hourHistogram: Record<string, number>; // learner-local hour → event count
  preferredHours: number[]; // modal hour(s)
  velocity: number; // lessons completed per active day
  totals: {
    events: number;
    quizAnswered: number;
    correct: number;
    wrong: number;
    lessonsCompleted: number;
  };
  timezone: string;
  computedAt: string;
}

/** Lesson key for grouping: explicit lesson_id from the legacy quiz path,
 *  otherwise the FSM node id from the authored path. */
function lessonKey(e: LearnerEvent): string {
  return e.payload?.lesson_id ?? e.node_id ?? 'unknown';
}

export function resolveTimezone(tz?: string | null): string {
  if (!tz || tz === 'UTC') return DEFAULT_TIMEZONE;
  try {
    // Reject unknown tz names up front so every formatter below is safe.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function localHour(date: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone,
    }).format(date);
    return parseInt(h, 10);
  } catch {
    // Unknown tz string on the learner row — fall back to the default.
    return localHour(date, DEFAULT_TIMEZONE);
  }
}

export function computeProfile(events: LearnerEvent[], timezone?: string | null): LearnerProfileData {
  const tz = resolveTimezone(timezone);
  const sorted = [...events].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const byLesson = new Map<string, boolean[]>(); // ordered correctness per lesson
  const hourHistogram: Record<string, number> = {};
  const activeDays = new Set<string>();
  // Re-delivery after a course re-import replays day_end/end nodes — count each
  // completion node once so velocity and totals stay honest.
  const completedNodes = new Set<string>();
  let quizAnswered = 0;
  let correct = 0;
  let lessonsCompleted = 0;

  for (const e of sorted) {
    const when = new Date(e.created_at);
    const hour = localHour(when, tz);
    hourHistogram[hour] = (hourHistogram[hour] ?? 0) + 1;
    // Active day in learner-local time (en-CA gives YYYY-MM-DD).
    activeDays.add(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(when));

    if (e.type === 'quiz_answered') {
      quizAnswered++;
      const isCorrect = !!e.payload?.correct;
      if (isCorrect) correct++;
      const key = lessonKey(e);
      if (!byLesson.has(key)) byLesson.set(key, []);
      byLesson.get(key)!.push(isCorrect);
    } else if (e.type === 'lesson_completed') {
      const dedupKey = `${e.type}:${e.node_id ?? 'unknown'}`;
      if (!completedNodes.has(dedupKey)) {
        completedNodes.add(dedupKey);
        lessonsCompleted++;
      }
    }
  }

  // Recency-weighted mastery: attempts ordered oldest→newest, weight DECAY^(n-1-i).
  const mastery: Record<string, number> = {};
  const struggles: string[] = [];
  for (const [key, attempts] of byLesson) {
    let weightSum = 0;
    let correctSum = 0;
    const n = attempts.length;
    attempts.forEach((ok, i) => {
      const w = Math.pow(DECAY, n - 1 - i);
      weightSum += w;
      if (ok) correctSum += w;
    });
    mastery[key] = weightSum > 0 ? Number((correctSum / weightSum).toFixed(4)) : 0;
    const wrongCount = attempts.filter((ok) => !ok).length;
    if (wrongCount >= STRUGGLE_WRONG_THRESHOLD) struggles.push(key);
  }

  const maxCount = Math.max(0, ...Object.values(hourHistogram));
  const preferredHours = Object.entries(hourHistogram)
    .filter(([, c]) => c === maxCount && maxCount > 0)
    .map(([h]) => Number(h))
    .sort((a, b) => a - b);

  const velocity =
    activeDays.size > 0 ? Number((lessonsCompleted / activeDays.size).toFixed(4)) : 0;

  return {
    mastery,
    struggles: struggles.sort(),
    hourHistogram,
    preferredHours,
    velocity,
    totals: {
      events: sorted.length,
      quizAnswered,
      correct,
      wrong: quizAnswered - correct,
      lessonsCompleted,
    },
    timezone: tz,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Persist an event and refresh the learner's stored profile.
 * NEVER throws — a signals failure must not block message delivery (AC1b).
 * Injectable db for tests.
 */
export async function recordLearnerEvent(
  data: {
    learnerId: string;
    courseId?: string | null;
    nodeId?: string | null;
    type: string;
    payload?: any;
    timezone?: string | null;
  },
  dbOverride?: any,
): Promise<void> {
  try {
    const db = dbOverride ?? (await getDb());
    await db.learnerEvents.create({
      learnerId: data.learnerId,
      courseId: data.courseId ?? null,
      nodeId: data.nodeId ?? null,
      type: data.type,
      payload: data.payload ?? {},
    });
    // Pilot-scale recompute: full recompute per event keeps the math trivially
    // correct; revisit incrementality only if event volume ever demands it.
    // Concurrent recomputes are last-write-wins over the same event set ±1 —
    // self-healing on the next event, accepted at pilot scale.
    const events = await db.learnerEvents.findByLearner(data.learnerId);
    const profile = computeProfile(events, data.timezone);
    await db.learnerEvents.updateLearnerProfile(data.learnerId, profile);
  } catch (err) {
    logger.warn(`learner_events write skipped (never blocks delivery) [${data.learnerId}]: ${(err as Error)?.message}`);
  }
}

/** Fresh profile for the admin endpoint: recompute from events, persist, return. */
export async function getLearnerProfile(learnerId: string, timezone?: string | null, dbOverride?: any) {
  const db = dbOverride ?? (await getDb());
  const events = await db.learnerEvents.findByLearner(learnerId);
  const profile = computeProfile(events, timezone);
  try {
    await db.learnerEvents.updateLearnerProfile(learnerId, profile);
  } catch (err) {
    logger.warn(`profile persist skipped [${learnerId}]: ${(err as Error)?.message}`);
  }
  return profile;
}
