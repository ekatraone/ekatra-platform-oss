/**
 * Course de-duplication must only reuse AI-generated, lesson-backed courses
 * in the learner's language.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReusableCourse } from '../courseGenerator.js';

const aiCourse = (over: any = {}) => ({
  title: 'Python Basics for Beginners',
  source: 'ai_generated',
  fsm_definition_id: null,
  settings: { language: 'en', aiGenerated: true },
  ...over,
});

test('reuses an AI-generated course in the same language with matching title', () => {
  assert.equal(isReusableCourse(aiCourse(), 'python basics', 'en'), true);
});

test('does not hand an English course to a Hindi learner', () => {
  assert.equal(isReusableCourse(aiCourse(), 'python basics', 'hi'), false);
  assert.equal(isReusableCourse(aiCourse({ settings: { language: 'hi', aiGenerated: true } }), 'python basics', 'hi'), true);
});

test('treats a course without a language setting as English', () => {
  assert.equal(isReusableCourse(aiCourse({ settings: { aiGenerated: true } }), 'python basics', 'en'), true);
});

test('never reuses authored / FSM-delivered courses (no lesson rows)', () => {
  const authored = { title: 'Design Thinking', source: 'authored', fsm_definition_id: 'f1', settings: {} };
  assert.equal(isReusableCourse(authored, 'design thinking', 'en'), false);
  assert.equal(isReusableCourse(aiCourse({ title: 'Design Thinking', fsm_definition_id: 'f1' }), 'design thinking', 'en'), false);
  assert.equal(isReusableCourse(aiCourse({ title: 'Design Thinking', source: 'authored' }), 'design thinking', 'en'), false);
});

test('ignores courses not marked AI-generated', () => {
  assert.equal(isReusableCourse(aiCourse({ settings: { language: 'en' } }), 'python basics', 'en'), false);
});

test('keeps the 80% title-word overlap rule', () => {
  assert.equal(isReusableCourse(aiCourse(), 'marketing fundamentals', 'en'), false);
  assert.equal(isReusableCourse(aiCourse(), 'C++', 'en'), false); // no words > 3 letters
});

// ── micro size / force ─────────────────────────────────────────────────────

import { CourseGeneratorService, resolveCourseSize } from '../courseGenerator.js';

function stubbedGenerator(existing: any = null) {
  const svc: any = new CourseGeneratorService();
  const seen = { llm: [] as any[], findExisting: 0, saved: [] as any[] };
  svc.findExistingCourse = async () => { seen.findExisting++; return existing; };
  svc.callLLM = async (...args: any[]) => { seen.llm.push(args); return { title: 't', description: 'd', days: [] }; };
  svc.saveToDB = async (...args: any[]) => { seen.saved.push(args); return { id: 'new-course' }; };
  return { svc: svc as CourseGeneratorService, seen };
}

test('micro size generates 1 day × 3 modules even when more were requested', async () => {
  const { svc, seen } = stubbedGenerator();
  await svc.generate({ topic: 'x', organizationId: 'o', size: 'micro', numDays: 5, numModules: 5 });
  const [, , , , numDays, numModules, size] = seen.llm[0];
  assert.deepEqual([numDays, numModules, size], [1, 3, 'micro']);
});

test('standard size keeps the 3×3 minimum clamp', async () => {
  const { svc, seen } = stubbedGenerator();
  await svc.generate({ topic: 'x', organizationId: 'o', size: 'standard', numDays: 1, numModules: 1 });
  const [, , , , numDays, numModules] = seen.llm[0];
  assert.deepEqual([numDays, numModules], [3, 3]);
});

test('force skips the existing-course check; without it an existing course is reused', async () => {
  const forced = stubbedGenerator({ id: 'old-course' });
  const a = await forced.svc.generate({ topic: 'x', organizationId: 'o', size: 'micro', force: true });
  assert.equal(forced.seen.findExisting, 0);
  assert.equal(a.id, 'new-course');

  const reused = stubbedGenerator({ id: 'old-course' });
  const b = await reused.svc.generate({ topic: 'x', organizationId: 'o', size: 'micro' });
  assert.equal(b.id, 'old-course');
  assert.equal(reused.seen.llm.length, 0);
});

test('provider is passed through to the LLM call and the saved course', async () => {
  const { svc, seen } = stubbedGenerator();
  await svc.generate({ topic: 'x', organizationId: 'o', size: 'micro', provider: 'meta', force: true });
  assert.equal(seen.llm[0][7], 'meta');
  assert.equal(seen.saved[0][4], 'meta');
});

test('COURSE_SIZE env sets the default size; an explicit size wins', () => {
  const prev = process.env.COURSE_SIZE;
  try {
    process.env.COURSE_SIZE = 'micro';
    assert.equal(resolveCourseSize(), 'micro');
    assert.equal(resolveCourseSize('standard'), 'standard');
    delete process.env.COURSE_SIZE;
    assert.equal(resolveCourseSize(), 'standard');
  } finally {
    if (prev === undefined) delete process.env.COURSE_SIZE; else process.env.COURSE_SIZE = prev;
  }
});
