/**
 * Sync service — claim/idempotency of lesson requests, bundle building, and
 * idempotent, server-graded event ingest. Uses an in-memory stub database that
 * mirrors the semantics of the SQL in syncService.ts (real SQL is exercised by
 * the local end-to-end run).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestLesson,
  buildBundle,
  getMe,
  applyEvents,
  SyncError,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_AGE_MS,
  CourseGeneratorLike,
} from '../syncService.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const LEARNER = { id: '00000000-0000-4000-8000-0000000000b1', organizationId: ORG };
const COURSE = '00000000-0000-4000-8000-0000000000c1';
const LESSON1 = '00000000-0000-4000-8000-0000000000d1';
const LESSON2 = '00000000-0000-4000-8000-0000000000d2';
const Q1 = '00000000-0000-4000-8000-0000000000e1';
const Q2 = '00000000-0000-4000-8000-0000000000e2';
const MEDIA_COVER = '00000000-0000-4000-8000-0000000000a1';
const MEDIA_M1 = '00000000-0000-4000-8000-0000000000a2';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Req { status: string; course_id: string | null; updatedAt: number; attempt: number }

function makeDb(opts: { authored?: boolean; enrolled?: boolean; otherOrg?: boolean; extraCourses?: number } = {}) {
  const enrolled = opts.enrolled ?? true;
  const requests = new Map<string, Req>();
  const seenEvents = new Set<string>();
  const stored: any[] = [];
  const calls = { profileWrites: 0, quizResponses: 0, progressUpserts: 0, enrollmentUpdates: 0, enrollInserts: 0 };
  let clock = Date.now();

  const course = {
    id: COURSE,
    title: 'Compound interest',
    description: 'd',
    settings: { language: 'en', coverImageUrl: `/api/sync/media/${MEDIA_COVER}`, generator: { provider: 'meta', model: 'muse-wonder-1.0' } },
    source: opts.authored ? 'authored' : 'ai_generated',
    fsm_definition_id: null,
    organization_id: opts.otherOrg ? 'other-org' : ORG,
  };
  const lessons = [
    { id: LESSON1, title: 'One', content: 'a', content_type: 'text', sequence_order: 1, day_number: 1, course_id: COURSE, media_url: `/api/sync/media/${MEDIA_M1}` },
    { id: LESSON2, title: 'Day 1 Review', content: '', content_type: 'review', sequence_order: 2, day_number: null, course_id: COURSE, media_url: `/api/sync/media/${uuid(777)}` },
  ];
  const questions = [
    // options stored as a JSON string on purpose: JSONB can come back stringified
    { id: Q1, lesson_id: LESSON1, question: 'q1', options: JSON.stringify(['a', 'b', 'c', 'd']), correct_answer: 'B', explanation: 'e1' },
    { id: Q2, lesson_id: LESSON2, question: 'q2', options: ['a', 'b', 'c', 'd'], correct_answer: 'C', explanation: 'e2' },
  ];

  let queryCount = 0;
  const db = {
    calls,
    get queryCount() { return queryCount; },
    requests,
    stored,
    advance(ms: number) { clock += ms; },
    async raw(sql: string, p: any[] = []) {
      queryCount++;
      const has = (s: string) => sql.includes(s);
      if (has('INSERT INTO sync_lesson_requests')) {
        const key = `${p[0]}|${p[1]}`;
        const cur = requests.get(key);
        const [, , staleSecs, maxAttempts, retrySecs] = p;
        const takeover = cur && (
          (cur.status === 'done' && !cur.course_id) ||
          (cur.attempt < maxAttempts && (
            (cur.status === 'failed' && clock - cur.updatedAt > retrySecs * 1000) ||
            (cur.status === 'generating' && clock - cur.updatedAt > staleSecs * 1000))));
        if (!cur || takeover) {
          const attempt = cur ? cur.attempt + 1 : 1;
          requests.set(key, { status: 'generating', course_id: null, updatedAt: clock, attempt });
          return { rows: [{ attempt }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (has('SELECT status, course_id, attempt')) {
        const cur = requests.get(`${p[0]}|${p[1]}`);
        return { rows: cur ? [{ status: cur.status, course_id: cur.course_id, attempt: cur.attempt,
          stale: clock - cur.updatedAt > p[2] * 1000 }] : [] };
      }
      if (has("UPDATE sync_lesson_requests SET updated_at = NOW()")) {
        const r = requests.get(`${p[0]}|${p[1]}`);
        if (r && r.attempt === p[2] && r.status === 'generating') r.updatedAt = clock;
        return { rows: [] };
      }
      if (has("UPDATE sync_lesson_requests SET status = 'failed'")) {
        const r = requests.get(`${p[0]}|${p[1]}`)!;
        if (r.attempt === p[2] && r.status === 'generating') { r.status = 'failed'; r.updatedAt = clock; }
        return { rows: [] };
      }
      if (has("UPDATE sync_lesson_requests SET status = 'done'")) {
        const r = requests.get(`${p[0]}|${p[1]}`)!;
        if (r.attempt !== p[3] || r.status !== 'generating') return { rows: [] };
        r.status = 'done'; r.course_id = p[2]; r.updatedAt = clock;
        return { rows: [{ attempt: r.attempt }] };
      }
      if (has('INSERT INTO enrollments')) { calls.enrollInserts++; return { rows: [] }; }
      if (has('SELECT id, name, phone, language')) return { rows: [{ id: LEARNER.id, name: 'Demo', phone: '+910000000042', language: 'en' }] };
      if (has('c.settings, e.status, e.progress')) {
        const extras = Array.from({ length: opts.extraCourses ?? 0 }, (_, i) => ({
          id: uuid(5000 + i), title: `Extra ${i}`, settings: { language: 'en' }, status: 'enrolled', progress: 0 }));
        return { rows: enrolled ? [{ id: COURSE, title: course.title, settings: course.settings, status: 'enrolled', progress: 0 }, ...extras] : [] };
      }
      if (has('FROM lessons WHERE course_id = ANY')) {
        return { rows: lessons.filter((l) => p[0].includes(l.course_id)) };
      }
      if (has('SELECT id, title FROM lessons WHERE id = ANY')) return { rows: [] };
      if (has('FROM enrollments e JOIN courses c')) {
        return { rows: enrolled && p[1] === COURSE ? [course] : [] };
      }
      if (has('FROM lessons WHERE course_id')) return { rows: lessons };
      if (has('FROM quiz_questions WHERE lesson_id = ANY')) return { rows: questions };
      if (has('JOIN enrollments e ON e.course_id = l.course_id')) {
        const ok = enrolled && !opts.authored && !opts.otherOrg;
        return { rows: ok ? lessons.filter((l) => p[1].includes(l.id)).map((l) => ({ id: l.id, course_id: l.course_id })) : [] };
      }
      if (has('SELECT id, lesson_id, correct_answer FROM quiz_questions')) {
        return { rows: questions.filter((q) => p[0].includes(q.id)) };
      }
      if (has('WITH ins AS')) {
        const id = p[5];
        if (seenEvents.has(id)) return { rows: [], rowCount: 0 };
        seenEvents.add(id);
        stored.push({ type: 'quiz_answered', node_id: p[2], payload: JSON.parse(p[3]), created_at: p[4] });
        calls.quizResponses++;
        return { rows: [], rowCount: 1 };
      }
      if (has("'lesson_completed'") && has('INSERT INTO learner_events')) {
        const id = p[5];
        if (seenEvents.has(id)) return { rows: [] };
        seenEvents.add(id);
        stored.push({ type: 'lesson_completed', node_id: p[2], payload: JSON.parse(p[3]), created_at: p[4] });
        return { rows: [{ id }] };
      }
      if (has('INSERT INTO lesson_progress')) { calls.progressUpserts++; return { rows: [] }; }
      if (has('UPDATE enrollments e')) { calls.enrollmentUpdates++; return { rows: [] }; }
      if (has('SELECT type, node_id, payload, created_at FROM learner_events')) return { rows: stored };
      if (has('SELECT timezone FROM learners')) return { rows: [{ timezone: null }] };
      if (has('UPDATE learners SET profile')) { calls.profileWrites++; return { rows: [] }; }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  return db;
}

function makeGenerator(fail = false) {
  const calls: any[] = [];
  const gen: CourseGeneratorLike & { calls: any[] } = {
    calls,
    async generate(params) {
      calls.push(params);
      if (fail) throw new Error('muse down');
      return { id: COURSE };
    },
  };
  return gen;
}

const rid = () => uuid(Math.floor(Math.random() * 1e9));
const input = (id: string) => ({ topic: 'Compound interest', language: 'en', clientRequestId: id });

// ── lesson request: claim paths ────────────────────────────────────────────

test('request: first call claims, generates a micro lesson once, marks done', async () => {
  const db = makeDb(); const gen = makeGenerator(); const id = rid();
  const res = await requestLesson(db, gen, LEARNER, input(id));
  assert.equal(res.courseId, COURSE);
  assert.equal(res.bundle.lessons.length, 2);
  assert.equal(gen.calls.length, 1);
  assert.deepEqual(
    { size: gen.calls[0].size, provider: gen.calls[0].provider, force: gen.calls[0].force },
    { size: 'micro', provider: 'meta', force: true });
  assert.equal(db.requests.get(`${LEARNER.id}|${id}`)!.status, 'done');
});

test('request: done id returns the same bundle with no new generation', async () => {
  const db = makeDb(); const gen = makeGenerator(); const id = rid();
  const first = await requestLesson(db, gen, LEARNER, input(id));
  const again = await requestLesson(db, gen, LEARNER, input(id));
  assert.deepEqual(again, first);
  assert.equal(gen.calls.length, 1);
});

test('request: in-flight id returns 409 in_progress and never starts a second generation', async () => {
  const db = makeDb(); const gen = makeGenerator(); const id = rid();
  // A first call is mid-generation: its claim exists but it has not finished.
  let release!: () => void;
  const slow: CourseGeneratorLike & { calls: any[] } = {
    calls: [],
    generate: (params) => { slow.calls.push(params); return new Promise((r) => { release = () => r({ id: COURSE }); }); },
  };
  const first = requestLesson(db, slow, LEARNER, input(id));
  await new Promise((r) => setImmediate(r));

  await assert.rejects(
    requestLesson(db, gen, LEARNER, input(id)),
    (e: any) => e instanceof SyncError && e.status === 409 && e.message === 'in_progress');
  assert.equal(gen.calls.length, 0);
  assert.equal(slow.calls.length, 1);

  release();
  await first;
});

test('request: a stale generating claim is re-claimed and generated again', async () => {
  const db = makeDb(); const id = rid();
  db.requests.set(`${LEARNER.id}|${id}`, { status: 'generating', course_id: null, updatedAt: Date.now(), attempt: 1 });
  const gen = makeGenerator();

  // Fresh claim: still in progress.
  await assert.rejects(requestLesson(db, gen, LEARNER, input(id)), (e: any) => e.status === 409);

  db.advance(6 * 60 * 1000);
  const res = await requestLesson(db, gen, LEARNER, input(id));
  assert.equal(res.courseId, COURSE);
  assert.equal(gen.calls.length, 1);
  assert.equal(db.requests.get(`${LEARNER.id}|${id}`)!.status, 'done');
});

test('request: generation failure marks the claim failed (5xx) and a retry generates again', async () => {
  const db = makeDb(); const id = rid();
  await assert.rejects(
    requestLesson(db, makeGenerator(true), LEARNER, input(id)),
    (e: any) => e instanceof SyncError && e.status >= 500);
  assert.equal(db.requests.get(`${LEARNER.id}|${id}`)!.status, 'failed');

  db.advance(61_000);
  const gen = makeGenerator();
  const res = await requestLesson(db, gen, LEARNER, input(id));
  assert.equal(res.courseId, COURSE);
  assert.equal(gen.calls.length, 1);
});

test('request: validates topic, language and clientRequestId (400)', async () => {
  const db = makeDb(); const gen = makeGenerator();
  for (const bad of [
    { topic: 'x', clientRequestId: rid() },
    { topic: 'y'.repeat(121), clientRequestId: rid() },
    { topic: 'fine topic', clientRequestId: 'not-a-uuid' },
    { topic: 'fine topic', language: 'english!!', clientRequestId: rid() },
  ]) {
    await assert.rejects(requestLesson(db, gen, LEARNER, bad), (e: any) => e instanceof SyncError && e.status === 400);
  }
  assert.equal(gen.calls.length, 0);
});

// ── claim fencing, heartbeat, retry cap ────────────────────────────────────

function slowGenerator() {
  const calls: any[] = [];
  let release!: () => void;
  const gen: CourseGeneratorLike & { calls: any[]; release: () => void } = {
    calls,
    release: () => release(),
    generate: (params) => { calls.push(params); return new Promise((r) => { release = () => r({ id: COURSE }); }); },
  };
  return gen;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('request: a superseded run cannot mark the claim done or enroll the learner', async () => {
  const db = makeDb(); const id = rid();
  const a = slowGenerator();
  // heartbeat effectively off, so the claim goes stale while A is still running
  const runA = requestLesson(db, a, LEARNER, input(id), { heartbeatMs: 3_600_000 });
  const outcomeA = runA.then(() => 'ok', (e) => e);
  await tick();

  db.advance(6 * 60 * 1000);
  const b = makeGenerator();
  const resB = await requestLesson(db, b, LEARNER, input(id));
  assert.equal(resB.courseId, COURSE);
  assert.equal(db.requests.get(`${LEARNER.id}|${id}`)!.attempt, 2);
  const enrollsAfterB = db.calls.enrollInserts;

  a.release();
  const e: any = await outcomeA;
  assert.ok(e instanceof SyncError && e.status === 409 && e.message === 'in_progress');
  assert.equal(db.calls.enrollInserts, enrollsAfterB); // A did not enroll
  assert.equal(db.requests.get(`${LEARNER.id}|${id}`)!.status, 'done');
});

test('request: a running generation refreshes its claim, so it is not taken over', async () => {
  const db = makeDb(); const id = rid();
  const a = slowGenerator();
  const runA = requestLesson(db, a, LEARNER, input(id), { heartbeatMs: 5 });
  await tick(20);
  db.advance(6 * 60 * 1000);
  await tick(30); // heartbeat runs with the advanced clock

  const b = makeGenerator();
  await assert.rejects(requestLesson(db, b, LEARNER, input(id)), (e: any) => e.status === 409);
  assert.equal(b.calls.length, 0);

  a.release();
  await runA;
});

test('request: a failed claim cannot be retried for 60 s (409), then can', async () => {
  const db = makeDb(); const id = rid();
  await assert.rejects(requestLesson(db, makeGenerator(true), LEARNER, input(id)), (e: any) => e.status === 502);

  const gen = makeGenerator();
  db.advance(30_000);
  await assert.rejects(requestLesson(db, gen, LEARNER, input(id)),
    (e: any) => e.status === 409 && e.message === 'in_progress');
  assert.equal(gen.calls.length, 0);

  db.advance(31_000);
  assert.equal((await requestLesson(db, gen, LEARNER, input(id))).courseId, COURSE);
});

test('request: after 3 failed attempts the request is dropped with 422 generation_failed', async () => {
  const db = makeDb(); const id = rid(); const gen = makeGenerator(true);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(requestLesson(db, gen, LEARNER, input(id)), (e: any) => e.status === 502);
    db.advance(61_000);
  }
  assert.equal(gen.calls.length, 3);
  await assert.rejects(requestLesson(db, gen, LEARNER, input(id)),
    (e: any) => e instanceof SyncError && e.status === 422 && e.message === 'generation_failed');
  assert.equal(gen.calls.length, 3); // no fourth Muse run
});

// ── bundle ─────────────────────────────────────────────────────────────────

test('bundle: parses stringified options, uppercases the key, sorts and labels review lessons', async () => {
  const b = await buildBundle(makeDb(), LEARNER, COURSE, 'https://demo.example');
  assert.equal(b.lessons[0].kind, 'module');
  assert.equal(b.lessons[1].kind, 'review');
  assert.equal(b.lessons[1].day, 1); // NULL day_number → 1
  assert.deepEqual(b.lessons[0].questions[0].options, ['a', 'b', 'c', 'd']);
  assert.equal(b.lessons[0].questions[0].correctAnswer, 'B');
  assert.deepEqual(b.course.generator, { provider: 'meta', model: 'muse-wonder-1.0' });
  assert.equal(b.course.coverImageUrl, `https://demo.example/api/sync/media/${MEDIA_COVER}`);
  assert.equal(b.lessons[0].imageUrl, `https://demo.example/api/sync/media/${MEDIA_M1}`);
  assert.equal(b.lessons[1].imageUrl, null); // review lessons never carry an image
  assert.match(b.version, /^[0-9a-f]{40}$/);
});

test('bundle: unenrolled or other-org learner gets 404; authored course gets 422', async () => {
  await assert.rejects(buildBundle(makeDb({ enrolled: false }), LEARNER, COURSE), (e: any) => e.status === 404);
  await assert.rejects(buildBundle(makeDb({ otherOrg: true }), LEARNER, COURSE), (e: any) => e.status === 404);
  await assert.rejects(buildBundle(makeDb({ authored: true }), LEARNER, COURSE), (e: any) => e.status === 422);
  await assert.rejects(buildBundle(makeDb(), LEARNER, 'nope'), (e: any) => e.status === 404);
});

// ── events ─────────────────────────────────────────────────────────────────

const ev = (n: number, over: any = {}) => ({
  clientEventId: uuid(1000 + n), type: 'quiz_answered', courseId: COURSE, lessonId: LESSON1,
  questionId: Q1, answer: 'B', clientCorrect: true, occurredAt: new Date().toISOString(), ...over,
});

test('events: a re-posted batch is all duplicates with no second quiz response', async () => {
  const db = makeDb();
  const batch = [ev(1), ev(2, { questionId: Q2, lessonId: LESSON2, answer: 'C' }),
    { clientEventId: uuid(1003), type: 'lesson_completed', courseId: COURSE, lessonId: LESSON1, occurredAt: new Date().toISOString() }];
  const first = await applyEvents(db, LEARNER, batch);
  assert.equal(first.accepted.length, 3);
  const again = await applyEvents(db, LEARNER, batch);
  assert.deepEqual(again.accepted, []);
  assert.equal(again.duplicates.length, 3);
  assert.equal(db.calls.quizResponses, 2);
  // lesson_completed side effects still run on a duplicate, so a partial failure heals
  assert.equal(db.calls.progressUpserts, 2);
});

test('events: the server regrades; the client claim is only stored for audit', async () => {
  const db = makeDb();
  const res = await applyEvents(db, LEARNER, [ev(1, { answer: 'A', clientCorrect: true })]);
  assert.equal(res.accepted.length, 1);
  assert.equal(db.stored[0].payload.correct, false);
  assert.equal(db.stored[0].payload.client_correct, true);
  assert.equal(res.profile.totals.wrong, 1);
});

test('events: foreign question, wrong lesson, unenrolled learner and bad shapes are rejected per event', async () => {
  const db = makeDb();
  const res = await applyEvents(db, LEARNER, [
    ev(1, { questionId: uuid(9999) }),                 // unknown question
    ev(2, { questionId: Q2 }),                         // question belongs to another lesson
    ev(3, { answer: 'Z' }),                            // invalid answer letter
    ev(4, { type: 'something_else' }),                 // unsupported type
    ev(5, { occurredAt: 'yesterday-ish' }),            // bad timestamp
    { ...ev(6), clientEventId: 'nope' },               // bad id
    ev(7),                                             // fine
  ]);
  assert.deepEqual(res.accepted, [uuid(1007)]);
  assert.equal(res.rejected.length, 6);

  const other = makeDb({ enrolled: false });
  const r2 = await applyEvents(other, LEARNER, [ev(1)]);
  assert.deepEqual(r2.rejected, [{ clientEventId: uuid(1001), reason: 'lesson_not_enrolled' }]);
  const authored = makeDb({ authored: true });
  const r3 = await applyEvents(authored, LEARNER, [ev(1)]);
  assert.equal(r3.rejected[0].reason, 'lesson_not_enrolled');
});

test('events: occurredAt is clamped to [now-30d, now]', async () => {
  const db = makeDb(); const now = new Date('2026-10-31T10:00:00Z');
  await applyEvents(db, LEARNER, [
    ev(1, { occurredAt: '2026-06-01T00:00:00Z' }),
    ev(2, { occurredAt: '2027-01-01T00:00:00Z' }),
    ev(3, { occurredAt: '2026-10-30T10:00:00Z' }),
  ], now);
  const times = db.stored.map((s) => new Date(s.created_at).getTime());
  assert.equal(times[0], now.getTime() - MAX_EVENT_AGE_MS);
  assert.equal(times[1], now.getTime());
  assert.equal(times[2], Date.parse('2026-10-30T10:00:00Z'));
});

test('events: batch size is enforced (1–50) as a whole-request 400', async () => {
  const db = makeDb();
  await assert.rejects(applyEvents(db, LEARNER, []), (e: any) => e.status === 400);
  await assert.rejects(applyEvents(db, LEARNER, 'x'), (e: any) => e.status === 400);
  const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ev(i));
  await assert.rejects(applyEvents(db, LEARNER, tooMany), (e: any) => e.status === 400);
  const max = Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => ev(i));
  assert.equal((await applyEvents(db, LEARNER, max)).accepted.length, MAX_EVENTS_PER_BATCH);
});

test('events: the profile is recomputed and stored once per batch', async () => {
  const db = makeDb();
  await applyEvents(db, LEARNER, [ev(1), ev(2), ev(3, { answer: 'A' })]);
  assert.equal(db.calls.profileWrites, 1);
});

test('bundle: image URLs are null when a course has no images', async () => {
  // A db whose course/lessons have no media
  const db: any = makeDb();
  const raw = db.raw.bind(db);
  db.raw = async (sql: string, p: any[]) => {
    const r = await raw(sql, p);
    if (sql.includes('FROM enrollments e JOIN courses c')) return { rows: r.rows.map((c: any) => ({ ...c, settings: { language: 'en' } })) };
    if (sql.includes('FROM lessons WHERE course_id')) return { rows: r.rows.map((l: any) => ({ ...l, media_url: null })) };
    return r;
  };
  const b = await buildBundle(db, LEARNER, COURSE);
  assert.equal(b.course.coverImageUrl, null);
  assert.deepEqual(b.lessons.map((l) => l.imageUrl), [null, null]);
});

test('bundle: stored values that are not a relative media path (old absolute URLs, junk) become null', async () => {
  const db: any = makeDb(); const raw = db.raw.bind(db);
  db.raw = async (sql: string, q: any[]) => {
    const r = await raw(sql, q);
    if (sql.includes('FROM enrollments e JOIN courses c')) {
      return { rows: r.rows.map((c: any) => ({ ...c, settings: { ...c.settings, coverImageUrl: `http://localhost:3001/api/sync/media/${MEDIA_COVER}` } })) };
    }
    if (sql.includes('FROM lessons WHERE course_id')) return { rows: r.rows.map((l: any) => ({ ...l, media_url: 'javascript:alert(1)' })) };
    return r;
  };
  const b = await buildBundle(db, LEARNER, COURSE, 'https://demo.example');
  assert.equal(b.course.coverImageUrl, null);
  assert.deepEqual(b.lessons.map((l) => l.imageUrl), [null, null]);
});

test('bundle: without a usable base URL, image URLs are null rather than relative', async () => {
  const b = await buildBundle(makeDb(), LEARNER, COURSE, null);
  assert.equal(b.course.coverImageUrl, null);
  assert.equal(b.lessons[0].imageUrl, null);
});

test('bundle: the version covers image ids (changes when a late image attaches) but not the base URL', async () => {
  const a = await buildBundle(makeDb(), LEARNER, COURSE, 'https://one.example');
  const sameElsewhere = await buildBundle(makeDb(), LEARNER, COURSE, 'https://two.example');
  assert.equal(a.version, sameElsewhere.version);

  const withLateImage: any = makeDb(); const raw = withLateImage.raw.bind(withLateImage);
  withLateImage.raw = async (sql: string, q: any[]) => {
    const r = await raw(sql, q);
    if (sql.includes('FROM lessons WHERE course_id')) {
      return { rows: r.rows.map((l: any) => l.id === LESSON1 ? { ...l, media_url: `/api/sync/media/${uuid(888)}` } : l) };
    }
    return r;
  };
  const later = await buildBundle(withLateImage, LEARNER, COURSE, 'https://one.example');
  assert.notEqual(later.version, a.version);

  const noCover: any = makeDb(); const raw2 = noCover.raw.bind(noCover);
  noCover.raw = async (sql: string, q: any[]) => {
    const r = await raw2(sql, q);
    if (sql.includes('FROM enrollments e JOIN courses c')) return { rows: r.rows.map((c: any) => ({ ...c, settings: { language: 'en' } })) };
    return r;
  };
  assert.notEqual((await buildBundle(noCover, LEARNER, COURSE, 'https://one.example')).version, a.version);
});

test('/me: every course entry carries the bundleVersion of its bundle', async () => {
  const db = makeDb();
  const me = await getMe(db, LEARNER);
  const bundle = await buildBundle(db, LEARNER, COURSE);
  assert.equal(me.courses.length, 1);
  assert.equal(me.courses[0].bundleVersion, bundle.version);
  assert.match(me.courses[0].bundleVersion as string, /^[0-9a-f]{40}$/);
});

test('/me: the batched bundleVersion is identical to the bundle version, for every course', async () => {
  const db = makeDb({ extraCourses: 2 });
  const me = await getMe(db, LEARNER);
  const bundle = await buildBundle(db, LEARNER, COURSE, 'https://any.example');
  assert.equal(me.courses[0].bundleVersion, bundle.version);
  // courses without lessons still get a stable, distinct version
  assert.equal(me.courses.length, 3);
  assert.ok(me.courses.slice(1).every((c) => /^[0-9a-f]{40}$/.test(c.bundleVersion as string)));
  assert.notEqual(me.courses[1].bundleVersion, me.courses[2].bundleVersion);
});

test('/me: the number of queries does not grow with the number of enrollments', async () => {
  const one = makeDb(); await getMe(one, LEARNER);
  const many = makeDb({ extraCourses: 25 }); await getMe(many, LEARNER);
  assert.equal(many.queryCount, one.queryCount);
});
