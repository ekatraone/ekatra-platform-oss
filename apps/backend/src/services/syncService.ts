/**
 * Sync service — backend side of the Maya offline app.
 *
 * Micro lessons are generated on demand (Muse), downloaded as a bundle the
 * phone can grade offline, and learner events come back in idempotent batches.
 *
 * The database is injected (anything with `raw(sql, params)`), so handlers and
 * tests never import the real pool. Contract: .claude/hackathon/CONTRACT.md.
 */

import { createHash } from 'node:crypto';
import { isMediaPath, mediaIdFromPath, publicBaseUrl } from '@ekatra/messaging';
import { computeProfile } from './learnerProfile.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SyncDb {
  raw(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface SyncLearner {
  id: string;
  organizationId: string;
  phone?: string;
}

export interface CourseGeneratorLike {
  generate(params: {
    topic: string;
    language?: string;
    organizationId: string;
    requestedByLearnerId?: string;
    size?: 'micro' | 'standard';
    provider?: 'meta';
    force?: boolean;
  }): Promise<{ id: string }>;
}

export class SyncError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface BundleQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}

export interface BundleLesson {
  id: string;
  kind: 'module' | 'review';
  title: string;
  content: string;
  day: number;
  order: number;
  imageUrl: string | null;
  questions: BundleQuestion[];
}

export interface Bundle {
  version: string;
  course: {
    id: string;
    title: string;
    description: string;
    language: string;
    generator: { provider: string; model: string } | null;
    coverImageUrl: string | null;
  };
  lessons: BundleLesson[];
}

// ── Constants / helpers ────────────────────────────────────────────────────

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A 'generating' claim older than this is assumed dead (server timeout is 240 s). */
export const STALE_CLAIM_SECONDS = 5 * 60;
/** A running generation refreshes its claim this often (well inside STALE_CLAIM_SECONDS). */
export const HEARTBEAT_MS = 30_000;
/** A failed claim can be retried after this long; before that the client sees 409 in_progress. */
export const FAILED_RETRY_SECONDS = 60;
/** After this many started generations for one clientRequestId the request is dropped (422). */
export const MAX_CLAIM_ATTEMPTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const EVENT_TYPES = new Set(['quiz_answered', 'lesson_completed']);

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function parseOptions(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.map((o) => String(o)) : [];
}

const isAuthored = (course: any) => course.source === 'authored' || !!course.fsm_definition_id;

// ── Lesson request (Muse generation, claimed atomically) ───────────────────

export interface LessonRequestInput {
  topic: unknown;
  language?: unknown;
  clientRequestId: unknown;
}

export interface RequestLessonOptions {
  /** A 'generating' claim with no heartbeat for this long is taken over. */
  staleSeconds?: number;
  /** How often a running generation refreshes its claim. */
  heartbeatMs?: number;
  /** A 'failed' claim cannot be retried before this many seconds have passed. */
  retryAfterSeconds?: number;
}

export async function requestLesson(
  db: SyncDb,
  generator: CourseGeneratorLike,
  learner: SyncLearner,
  input: LessonRequestInput,
  opts: RequestLessonOptions = {},
): Promise<{ courseId: string; bundle: Bundle }> {
  const staleSeconds = opts.staleSeconds ?? STALE_CLAIM_SECONDS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const retryAfterSeconds = opts.retryAfterSeconds ?? FAILED_RETRY_SECONDS;

  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (topic.length < 2 || topic.length > 120) {
    throw new SyncError(400, 'topic must be 2–120 characters');
  }
  const language = input.language === undefined ? 'en' : input.language;
  if (typeof language !== 'string' || !LANG_RE.test(language)) {
    throw new SyncError(400, 'language must be a language code such as "en"');
  }
  if (!isUuid(input.clientRequestId)) {
    throw new SyncError(400, 'clientRequestId must be a UUID');
  }
  const clientRequestId = input.clientRequestId;

  // Claim the id before calling Muse. The conflict branch only fires for a claim that
  // can be taken over, so two concurrent calls can never both come back with a row:
  //  - 'done' whose course was deleted (always retryable),
  //  - 'failed' for at least retryAfterSeconds, or 'generating' with no heartbeat for
  //    staleSeconds, both only while fewer than MAX_CLAIM_ATTEMPTS runs have started.
  // Each takeover bumps `attempt`; that number fences every later write of this run.
  const claim = await db.raw(
    `INSERT INTO sync_lesson_requests (learner_id, client_request_id, status)
     VALUES ($1, $2, 'generating')
     ON CONFLICT (learner_id, client_request_id) DO UPDATE
       SET status = 'generating', course_id = NULL,
           attempt = sync_lesson_requests.attempt + 1, created_at = NOW(), updated_at = NOW()
       WHERE (sync_lesson_requests.status = 'done' AND sync_lesson_requests.course_id IS NULL)
          OR (sync_lesson_requests.attempt < $4 AND (
                (sync_lesson_requests.status = 'failed'
                  AND sync_lesson_requests.updated_at < NOW() - make_interval(secs => $5))
             OR (sync_lesson_requests.status = 'generating'
                  AND sync_lesson_requests.updated_at < NOW() - make_interval(secs => $3))))
     RETURNING attempt`,
    [learner.id, clientRequestId, staleSeconds, MAX_CLAIM_ATTEMPTS, retryAfterSeconds],
  );

  if (!claim.rows.length) {
    const existing = await db.raw(
      `SELECT status, course_id, attempt,
              (updated_at < NOW() - make_interval(secs => $3)) AS stale
       FROM sync_lesson_requests WHERE learner_id = $1 AND client_request_id = $2`,
      [learner.id, clientRequestId, staleSeconds],
    );
    const row = existing.rows[0];
    if (row?.status === 'done' && row.course_id) {
      await enroll(db, learner.id, row.course_id);
      return { courseId: row.course_id, bundle: await buildBundle(db, learner, row.course_id) };
    }
    // Out of attempts: tell the client to drop the request instead of looping on Muse.
    if (row && row.attempt >= MAX_CLAIM_ATTEMPTS && (row.status === 'failed' || (row.status === 'generating' && row.stale))) {
      throw new SyncError(422, 'generation_failed');
    }
    throw new SyncError(409, 'in_progress');
  }
  const attempt: number = claim.rows[0].attempt;

  // A generation can outlive staleSeconds (3 tries × 240 s); keep the claim fresh while we work.
  const heartbeat = setInterval(() => {
    db.raw(
      `UPDATE sync_lesson_requests SET updated_at = NOW()
       WHERE learner_id = $1 AND client_request_id = $2 AND attempt = $3 AND status = 'generating'`,
      [learner.id, clientRequestId, attempt],
    ).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();

  let courseId: string;
  try {
    const course = await generator.generate({
      topic,
      language,
      organizationId: learner.organizationId,
      requestedByLearnerId: learner.id,
      size: 'micro',
      provider: 'meta',
      force: true,
    });
    courseId = course.id;
  } catch (err) {
    clearInterval(heartbeat);
    await db
      .raw(
        `UPDATE sync_lesson_requests SET status = 'failed', updated_at = NOW()
         WHERE learner_id = $1 AND client_request_id = $2 AND attempt = $3 AND status = 'generating'`,
        [learner.id, clientRequestId, attempt],
      )
      .catch(() => undefined);
    throw err instanceof SyncError ? err : new SyncError(502, 'lesson_generation_failed');
  }
  clearInterval(heartbeat);

  // Only the run that still holds the claim may finish it or enroll the learner. A run that
  // was taken over (or whose claim was reset) must not mark it done or hand out its course.
  const done = await db.raw(
    `UPDATE sync_lesson_requests SET status = 'done', course_id = $3, updated_at = NOW()
     WHERE learner_id = $1 AND client_request_id = $2 AND attempt = $4 AND status = 'generating'
     RETURNING attempt`,
    [learner.id, clientRequestId, courseId, attempt],
  );
  if (!done.rows.length) throw new SyncError(409, 'in_progress');

  await enroll(db, learner.id, courseId);
  return { courseId, bundle: await buildBundle(db, learner, courseId) };
}

async function enroll(db: SyncDb, learnerId: string, courseId: string): Promise<void> {
  await db.raw(
    `INSERT INTO enrollments (learner_id, course_id, status, progress, started_at)
     VALUES ($1, $2, 'enrolled', 0, NOW())
     ON CONFLICT (learner_id, course_id) DO NOTHING`,
    [learnerId, courseId],
  );
}

// ── Bundle ─────────────────────────────────────────────────────────────────

/**
 * `baseUrl` makes stored relative media paths absolute; it defaults to PUBLIC_BASE_URL /
 * WEBHOOK_BASE_URL at call time. Stored values that aren't `/api/sync/media/<uuid>` become null.
 */
export async function buildBundle(
  db: SyncDb,
  learner: SyncLearner,
  courseId: string,
  baseUrl: string | null = publicBaseUrl(),
): Promise<Bundle> {
  const absolute = (stored: unknown): string | null => (isMediaPath(stored) && baseUrl ? `${baseUrl}${stored}` : null);
  if (!isUuid(courseId)) throw new SyncError(404, 'Course not found');

  const found = await db.raw(
    `SELECT c.id, c.title, c.description, c.settings, c.source, c.fsm_definition_id, c.organization_id
     FROM enrollments e JOIN courses c ON c.id = e.course_id
     WHERE e.learner_id = $1 AND e.course_id = $2`,
    [learner.id, courseId],
  );
  const course = found.rows[0];
  if (!course || course.organization_id !== learner.organizationId) {
    throw new SyncError(404, 'Course not found or not enrolled');
  }
  if (isAuthored(course)) {
    throw new SyncError(422, 'Authored courses are not available offline');
  }

  const lessonRows = (
    await db.raw(
      `SELECT id, title, content, content_type, sequence_order, day_number, media_url
       FROM lessons WHERE course_id = $1 ORDER BY sequence_order ASC`,
      [courseId],
    )
  ).rows;

  const questionRows = lessonRows.length
    ? (
        await db.raw(
          `SELECT id, lesson_id, question, options, correct_answer, explanation
           FROM quiz_questions WHERE lesson_id = ANY($1::uuid[])
           ORDER BY sequence_order ASC, created_at ASC`,
          [lessonRows.map((l: any) => l.id)],
        )
      ).rows
    : [];

  const lessons = shapeLessons(lessonRows, questionRows, absolute);
  const settings = course.settings ?? {};
  return {
    version: bundleVersion(course.title, settings, lessons, lessonRows),
    course: {
      id: course.id,
      title: course.title,
      description: course.description ?? '',
      language: settings.language ?? 'en',
      generator: settings.generator ?? null,
      coverImageUrl: absolute(settings.coverImageUrl),
    },
    lessons,
  };
}

/** Lesson and question rows → bundle lessons. Shared by the bundle and by the /me version batch. */
function shapeLessons(lessonRows: any[], questionRows: any[], absolute: (stored: unknown) => string | null): BundleLesson[] {
  const byLesson = new Map<string, BundleQuestion[]>();
  for (const q of questionRows) {
    const list = byLesson.get(q.lesson_id) ?? [];
    list.push({
      id: q.id,
      question: q.question,
      options: parseOptions(q.options),
      correctAnswer: String(q.correct_answer ?? '').trim().toUpperCase(),
      explanation: q.explanation ?? '',
    });
    byLesson.set(q.lesson_id, list);
  }
  return lessonRows.map((l: any) => ({
    id: l.id,
    kind: l.content_type === 'review' ? 'review' : 'module',
    title: l.title,
    content: l.content ?? '',
    day: l.day_number ?? 1,
    order: l.sequence_order,
    // Review lessons never carry an image; media_url is only ever set on modules we generated.
    imageUrl: l.content_type === 'review' ? null : absolute(l.media_url),
    questions: byLesson.get(l.id) ?? [],
  }));
}

/**
 * The bundle version. It covers the content and the image ids (not the base URL), so it changes
 * when late images attach. The single definition, used by both the bundle and /me.
 */
function bundleVersion(title: string, settings: any, lessons: BundleLesson[], lessonRows: any[]): string {
  const imageIds = {
    cover: mediaIdFromPath(settings?.coverImageUrl),
    lessons: lessonRows.map((l: any) => (l.content_type === 'review' ? null : mediaIdFromPath(l.media_url))),
  };
  return createHash('sha1')
    .update(JSON.stringify({ t: title, lessons: lessons.map((l) => ({ ...l, imageUrl: undefined })), imageIds }))
    .digest('hex');
}

/** Bundle versions for several courses in two queries total, whatever the number of enrollments. */
async function bundleVersions(db: SyncDb, courses: { id: string; title: string; settings: any }[]): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  if (!courses.length) return versions;

  const lessonRows = (
    await db.raw(
      `SELECT id, course_id, title, content, content_type, sequence_order, day_number, media_url
       FROM lessons WHERE course_id = ANY($1::uuid[]) ORDER BY course_id, sequence_order ASC`,
      [courses.map((c) => c.id)],
    )
  ).rows;
  const questionRows = lessonRows.length
    ? (
        await db.raw(
          `SELECT id, lesson_id, question, options, correct_answer, explanation
           FROM quiz_questions WHERE lesson_id = ANY($1::uuid[])
           ORDER BY sequence_order ASC, created_at ASC`,
          [lessonRows.map((l: any) => l.id)],
        )
      ).rows
    : [];

  const lessonsByCourse = new Map<string, any[]>();
  for (const l of lessonRows) lessonsByCourse.set(l.course_id, [...(lessonsByCourse.get(l.course_id) ?? []), l]);
  const none = () => null;
  for (const c of courses) {
    const rows = lessonsByCourse.get(c.id) ?? [];
    const ids = new Set(rows.map((l: any) => l.id));
    const shaped = shapeLessons(rows, questionRows.filter((q: any) => ids.has(q.lesson_id)), none);
    versions.set(c.id, bundleVersion(c.title, c.settings ?? {}, shaped, rows));
  }
  return versions;
}

// ── Events ─────────────────────────────────────────────────────────────────

export interface RejectedEvent {
  clientEventId: string;
  reason: string;
}

export interface ApplyEventsResult {
  accepted: string[];
  duplicates: string[];
  rejected: RejectedEvent[];
  profile: SyncProfile;
}

export type SyncProfile = Pick<
  ReturnType<typeof computeProfile>,
  'mastery' | 'struggles' | 'preferredHours' | 'velocity' | 'totals'
>;

const toSyncProfile = (p: ReturnType<typeof computeProfile>): SyncProfile => ({
  mastery: p.mastery,
  struggles: p.struggles,
  preferredHours: p.preferredHours,
  velocity: p.velocity,
  totals: p.totals,
});

export async function applyEvents(
  db: SyncDb,
  learner: SyncLearner,
  events: unknown,
  now: Date = new Date(),
): Promise<ApplyEventsResult> {
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS_PER_BATCH) {
    throw new SyncError(400, `events must be an array of 1–${MAX_EVENTS_PER_BATCH} items`);
  }

  const accepted: string[] = [];
  const duplicates: string[] = [];
  const rejected: RejectedEvent[] = [];

  // Shape validation first; what survives is checked against the database in bulk.
  type Valid = {
    clientEventId: string;
    type: 'quiz_answered' | 'lesson_completed';
    courseId: string;
    lessonId: string;
    questionId?: string;
    answer?: string;
    clientCorrect: boolean | null;
    occurredAt: Date;
  };
  const valid: Valid[] = [];
  const seen = new Set<string>();

  for (const raw of events) {
    const e = (raw ?? {}) as Record<string, any>;
    const id = isUuid(e.clientEventId) ? e.clientEventId : '';
    const reject = (reason: string) => rejected.push({ clientEventId: id || String(e.clientEventId ?? ''), reason });

    if (!id) { reject('invalid_client_event_id'); continue; }
    if (!EVENT_TYPES.has(e.type)) { reject('invalid_type'); continue; }
    if (!isUuid(e.courseId) || !isUuid(e.lessonId)) { reject('invalid_course_or_lesson'); continue; }
    const t = typeof e.occurredAt === 'string' ? Date.parse(e.occurredAt) : NaN;
    if (Number.isNaN(t)) { reject('invalid_occurred_at'); continue; }

    const occurredAt = new Date(Math.min(Math.max(t, now.getTime() - MAX_EVENT_AGE_MS), now.getTime()));
    const base = { clientEventId: id, courseId: e.courseId, lessonId: e.lessonId, occurredAt };

    if (e.type === 'quiz_answered') {
      const answer = typeof e.answer === 'string' ? e.answer.trim().toUpperCase() : '';
      if (!isUuid(e.questionId)) { reject('invalid_question'); continue; }
      if (!/^[A-D]$/.test(answer)) { reject('invalid_answer'); continue; }
      valid.push({
        ...base,
        type: 'quiz_answered',
        questionId: e.questionId,
        answer,
        clientCorrect: typeof e.clientCorrect === 'boolean' ? e.clientCorrect : null,
      });
    } else {
      valid.push({ ...base, type: 'lesson_completed', clientCorrect: null });
    }
    seen.add(id);
  }

  if (valid.length) {
    // Lessons must belong to a lesson-backed course the learner is enrolled in, in their org.
    const lessonRows = (
      await db.raw(
        `SELECT l.id, l.course_id
         FROM lessons l
         JOIN enrollments e ON e.course_id = l.course_id AND e.learner_id = $1
         JOIN courses c ON c.id = l.course_id
         WHERE l.id = ANY($2::uuid[]) AND c.organization_id = $3
           AND c.source <> 'authored' AND c.fsm_definition_id IS NULL`,
        [learner.id, [...new Set(valid.map((v) => v.lessonId))], learner.organizationId],
      )
    ).rows;
    const lessonCourse = new Map<string, string>(lessonRows.map((r: any) => [r.id, r.course_id]));

    const questionIds = [...new Set(valid.filter((v) => v.questionId).map((v) => v.questionId!))];
    const questionRows = questionIds.length
      ? (
          await db.raw(
            `SELECT id, lesson_id, correct_answer FROM quiz_questions WHERE id = ANY($1::uuid[])`,
            [questionIds],
          )
        ).rows
      : [];
    const questions = new Map<string, any>(questionRows.map((r: any) => [r.id, r]));

    const touchedCourses = new Set<string>();

    for (const ev of valid) {
      if (lessonCourse.get(ev.lessonId) !== ev.courseId) {
        rejected.push({ clientEventId: ev.clientEventId, reason: 'lesson_not_enrolled' });
        continue;
      }

      if (ev.type === 'quiz_answered') {
        const q = questions.get(ev.questionId!);
        if (!q || q.lesson_id !== ev.lessonId) {
          rejected.push({ clientEventId: ev.clientEventId, reason: 'unknown_question' });
          continue;
        }
        const correct = String(q.correct_answer ?? '').trim().toUpperCase() === ev.answer;
        const payload = {
          lesson_id: ev.lessonId,
          question_id: ev.questionId,
          answer: ev.answer,
          correct,
          client_correct: ev.clientCorrect,
          source: 'maya_app',
        };
        // Event and quiz response land together or not at all, and never twice.
        const res = await db.raw(
          `WITH ins AS (
             INSERT INTO learner_events (learner_id, course_id, node_id, type, payload, created_at, client_event_id)
             VALUES ($1::uuid, $2::uuid, $3, 'quiz_answered', $4::jsonb, $5::timestamptz, $6::uuid)
             ON CONFLICT (learner_id, client_event_id) DO NOTHING
             RETURNING id
           )
           INSERT INTO quiz_responses (learner_id, question_id, answer, is_correct, responded_at)
           SELECT $1::uuid, $7::uuid, $8, $9::boolean, $5::timestamptz
           WHERE EXISTS (SELECT 1 FROM ins)`,
          [learner.id, ev.courseId, ev.lessonId, JSON.stringify(payload), ev.occurredAt.toISOString(),
           ev.clientEventId, ev.questionId, ev.answer, correct],
        );
        (res.rowCount ? accepted : duplicates).push(ev.clientEventId);
      } else {
        const res = await db.raw(
          `INSERT INTO learner_events (learner_id, course_id, node_id, type, payload, created_at, client_event_id)
           VALUES ($1::uuid, $2::uuid, $3, 'lesson_completed', $4::jsonb, $5::timestamptz, $6::uuid)
           ON CONFLICT (learner_id, client_event_id) DO NOTHING
           RETURNING id`,
          [learner.id, ev.courseId, ev.lessonId, JSON.stringify({ lesson_id: ev.lessonId, source: 'maya_app' }),
           ev.occurredAt.toISOString(), ev.clientEventId],
        );
        (res.rows.length ? accepted : duplicates).push(ev.clientEventId);

        // Idempotent side effects run for duplicates too, so a partial failure heals on retry.
        await db.raw(
          `INSERT INTO lesson_progress (enrollment_id, lesson_id, status, started_at, completed_at, attempts)
           SELECT e.id, $2::uuid, 'completed', $3::timestamptz, $3::timestamptz, 1
           FROM enrollments e WHERE e.learner_id = $1 AND e.course_id = $4
           ON CONFLICT (enrollment_id, lesson_id) DO UPDATE
             SET status = 'completed',
                 completed_at = COALESCE(lesson_progress.completed_at, EXCLUDED.completed_at),
                 updated_at = NOW()`,
          [learner.id, ev.lessonId, ev.occurredAt.toISOString(), ev.courseId],
        );
        touchedCourses.add(ev.courseId);
      }
    }

    for (const courseId of touchedCourses) {
      await db.raw(
        `WITH c AS (
           SELECT
             (SELECT COUNT(*) FROM lesson_progress lp JOIN enrollments e ON e.id = lp.enrollment_id
               WHERE e.learner_id = $1 AND e.course_id = $2 AND lp.status = 'completed')::int AS done,
             (SELECT COUNT(*) FROM lessons WHERE course_id = $2)::int AS total
         ), p AS (
           SELECT LEAST(100, CASE WHEN total = 0 THEN 0 ELSE ROUND(100.0 * done / total) END)::int AS pct FROM c
         )
         UPDATE enrollments e
         SET progress = p.pct,
             status = CASE WHEN p.pct >= 100 THEN 'completed' WHEN p.pct > 0 THEN 'in_progress' ELSE e.status END,
             completed_at = CASE WHEN p.pct >= 100 THEN COALESCE(e.completed_at, NOW()) ELSE e.completed_at END,
             updated_at = NOW()
         FROM p
         WHERE e.learner_id = $1 AND e.course_id = $2`,
        [learner.id, courseId],
      );
    }
  }

  const profile = await refreshProfile(db, learner.id);
  return { accepted, duplicates, rejected, profile };
}

/** Recompute from all events and store on the learner row; once per request. */
async function refreshProfile(db: SyncDb, learnerId: string): Promise<SyncProfile> {
  const [{ rows: events }, { rows: tzRows }] = await Promise.all([
    db.raw(
      `SELECT type, node_id, payload, created_at FROM learner_events
       WHERE learner_id = $1 ORDER BY created_at ASC`,
      [learnerId],
    ),
    db.raw(`SELECT timezone FROM learners WHERE id = $1`, [learnerId]),
  ]);
  const profile = computeProfile(events, tzRows[0]?.timezone);
  await db.raw(`UPDATE learners SET profile = $1, updated_at = NOW() WHERE id = $2`, [
    JSON.stringify(profile),
    learnerId,
  ]);
  return toSyncProfile(profile);
}

// ── /me ────────────────────────────────────────────────────────────────────

export async function getMe(db: SyncDb, learner: SyncLearner) {
  const learnerRow = (
    await db.raw(`SELECT id, name, phone, language FROM learners WHERE id = $1`, [learner.id])
  ).rows[0];
  if (!learnerRow) throw new SyncError(404, 'Learner not found');

  const courseRows = (
    await db.raw(
      `SELECT c.id, c.title, c.settings, e.status, e.progress
       FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.learner_id = $1 AND c.source <> 'authored' AND c.fsm_definition_id IS NULL
       ORDER BY e.created_at DESC`,
      [learner.id],
    )
  ).rows;

  const profile = await refreshProfile(db, learner.id);
  const versions = await bundleVersions(db, courseRows);

  const lessonKeys = [...new Set([...Object.keys(profile.mastery), ...profile.struggles])].filter(isUuid);
  const titleRows = lessonKeys.length
    ? (await db.raw(`SELECT id, title FROM lessons WHERE id = ANY($1::uuid[])`, [lessonKeys])).rows
    : [];

  return {
    learner: {
      id: learnerRow.id,
      name: learnerRow.name ?? null,
      // "fb:<uid>" is a channel address for app-only learners, not a phone number.
      phone: typeof learnerRow.phone === 'string' && learnerRow.phone.startsWith('fb:') ? null : learnerRow.phone,
      language: learnerRow.language ?? 'en',
    },
    courses: courseRows.map((c: any) => ({
      courseId: c.id,
      title: c.title,
      language: c.settings?.language ?? 'en',
      status: c.status === 'completed' ? 'completed' : (c.progress ?? 0) > 0 ? 'in_progress' : 'enrolled',
      progress: c.progress ?? 0,
      generator: c.settings?.generator ?? null,
      // The phone refetches a stored bundle when this differs from the one it holds.
      bundleVersion: versions.get(c.id) ?? null,
    })),
    profile,
    lessonTitles: Object.fromEntries(titleRows.map((r: any) => [r.id, r.title])),
  };
}
