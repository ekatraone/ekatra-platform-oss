/**
 * Learner conversation flow — regression tests for the hardcoded, dynamic (M10)
 * and authored (M12) engines. All DB and messaging calls are mocked; nothing
 * here touches a database or a channel.
 */

import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '@ekatra/database';
import { messaging } from '@ekatra/messaging';
import {
  ConversationFSM,
  cleanFreeText,
  normalizeCommand,
  resolveDynamicState,
} from '../conversationFSM.js';

afterEach(() => mock.restoreAll());

// ── Pure helpers ────────────────────────────────────────────────────────────

test('normalizeCommand keeps Devanagari incl. matras, strips edge punctuation/emoji', () => {
  assert.equal(normalizeCommand('हिंदी'), 'हिंदी');
  assert.equal(normalizeCommand('  आसान भाषा! '), 'आसान भाषा');
  assert.equal(normalizeCommand('New Topic?'), 'new topic');
  assert.equal(normalizeCommand('👋 Hi!!'), 'hi');
  assert.equal(normalizeCommand('lang_en'), 'lang_en');
  assert.equal(normalizeCommand('​next﻿'), 'next');
  assert.equal(normalizeCommand('???'), '');
});

test('cleanFreeText keeps script, case and symbols but drops invisibles/control chars/edge emoji', () => {
  assert.equal(cleanFreeText('शेयर मार्केट की बेसिक्स'), 'शेयर मार्केट की बेसिक्स');
  assert.equal(cleanFreeText('C++'), 'C++');
  assert.equal(cleanFreeText('C#'), 'C#');
  assert.equal(cleanFreeText('🐍🔥 Python basics 🚀'), 'Python basics');
  assert.equal(cleanFreeText('What is a closure?'), 'What is a closure?');
  assert.equal(cleanFreeText('a​b‮c\u0007d'), 'abc d');
  assert.equal(cleanFreeText('line1\n\nline2'), 'line1 line2');
});

test('resolveDynamicState ignores slots saved for another enrollment or definition', () => {
  const enrollment = { id: 'e2', fsm_definition_id: 'f2' };
  assert.equal(resolveDynamicState({ state: 'end_1', enrollmentId: 'e1', fsmDefinitionId: 'f1' }, enrollment), undefined);
  assert.equal(resolveDynamicState({ state: 's3', enrollmentId: 'e2', fsmDefinitionId: 'f1' }, enrollment), undefined);
  assert.equal(resolveDynamicState({ state: 's3', enrollmentId: 'e2', fsmDefinitionId: 'f2' }, enrollment), 's3');
  // Legacy slot (pre per-enrollment keying) is trusted
  assert.equal(resolveDynamicState({ state: 's3', version: 4 }, enrollment), 's3');
  assert.equal(resolveDynamicState({ state: null, enrollmentId: 'e2' }, enrollment), undefined);
  assert.equal(resolveDynamicState(undefined, enrollment), undefined);
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface Sent { kind: string; to: string; body: string; buttons?: string[] }

function setup(opts: {
  fsm?: { state: string; data: any; version: number };
  activeEnrollment?: any;
  enrollments?: Record<string, any>;
  lessons?: Record<string, any>;
  progress?: Record<string, any>;
  quiz?: Record<string, any[]>;
  fsmDefinition?: any;
  dynamicSlot?: any;
}) {
  const sent: Sent[] = [];
  const calls: Record<string, any[][]> = {};
  const record = (name: string) => (...args: any[]) => { (calls[name] ??= []).push(args); };
  const learner: any = {
    id: 'L1',
    phone: 'tg:1',
    name: 'Asha Rao',
    language: 'en',
    metadata: {
      fsm: opts.fsm ?? { state: 'idle', data: {}, version: 1 },
      ...(opts.dynamicSlot ? { fsm_dynamic: opts.dynamicSlot } : {}),
    },
  };
  const enrollments = opts.enrollments ?? {};

  mock.method(messaging, 'sendText', async (to: string, m: any) => { sent.push({ kind: 'text', to, body: m.text }); return { success: true }; });
  mock.method(messaging, 'sendInteractiveButtons', async (to: string, m: any) => {
    sent.push({ kind: 'buttons', to, body: m.body, buttons: m.buttons.map((b: any) => b.id) });
    return { success: true };
  });
  mock.method(messaging, 'sendInteractiveList', async (to: string, m: any) => { sent.push({ kind: 'list', to, body: m.body }); return { success: true }; });

  mock.method(db.enrollments, 'findActiveByLearner', async () => opts.activeEnrollment ?? null);
  mock.method(db.enrollments, 'findById', async (id: string) => enrollments[id] ?? null);
  mock.method(db.enrollments, 'findByLearner', async () => Object.values(enrollments));
  mock.method(db.enrollments, 'update', async (id: string, data: any) => {
    record('enrollments.update')(id, data);
    if (enrollments[id]) {
      if (data.status) enrollments[id].status = data.status;
      if (data.currentLessonId) enrollments[id].current_lesson_id = data.currentLessonId;
    }
    return enrollments[id] ?? null;
  });
  mock.method(db.enrollments, 'create', async (...a: any[]) => { record('enrollments.create')(...a); return { id: 'new-enr' }; });
  mock.method(db.lessons, 'findById', async (id: string) => opts.lessons?.[id] ?? null);
  mock.method(db.lessons, 'findByCourse', async () => Object.values(opts.lessons ?? {}));
  mock.method(db.lessonProgress, 'find', async (_e: string, lessonId: string) => opts.progress?.[lessonId] ?? null);
  mock.method(db.quiz, 'findByLesson', async (lessonId: string) => opts.quiz?.[lessonId] ?? []);
  mock.method(db.quiz, 'saveResponse', async (d: any) => { record('quiz.saveResponse')(d); return d; });
  mock.method(db.learners, 'update', async () => learner);
  mock.method(db.learners, 'findById', async () => learner);
  mock.method(db.learners, 'updateFSM', async (_id: string, fsm: any) => { learner.metadata.fsm = fsm; return learner; });
  mock.method(db.flashcardProgress, 'countDueForLearner', async () => 0);
  mock.method(db.fsmDefinitions, 'findById', async () => opts.fsmDefinition ?? null);
  mock.method(db, 'raw', async (sql: string, params: any[]) => {
    record('raw')(sql, params);
    return { rows: [{ id: 'L1' }] };
  });
  // Fire-and-forget learner events (M13a) — stub if this build of the repo has them
  if ((db as any).learnerEvents?.create) mock.method((db as any).learnerEvents, 'create', async () => ({}));

  const delivery = {
    sendNextLesson: mock.fn(async () => true),
    markLessonComplete: mock.fn(async () => {}),
    markDayReviewComplete: mock.fn(async () => {}),
    runDayEndReview: mock.fn(async () => {}),
    sendQuiz: mock.fn(async () => {}),
  };
  const qa = { handleTextQuestion: mock.fn(async () => {}) };

  const fsm = new ConversationFSM();
  (fsm as any).courseDelivery = delivery;
  (fsm as any).qaService = qa;

  return { fsm, learner, sent, calls, delivery, qa, enrollments };
}

const text = (t: string) => ({ from: 'tg:1', type: 'text', text: t });

// ── #3: "Continue" must not skip an undelivered lesson ─────────────────────

test('next on an undelivered lesson delivers it instead of marking it complete', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'd2m1' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1', courseId: 'C1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { d2m1: { id: 'd2m1', content_type: 'text', day_number: 2 } },
    progress: {},
  });
  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'next' });
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 1);
  assert.equal(h.delivery.markLessonComplete.mock.callCount(), 0);
});

test('next on a delivered lesson completes it and advances', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'd1m1' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1', courseId: 'C1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { d1m1: { id: 'd1m1', content_type: 'text', day_number: 1 } },
    progress: { d1m1: { id: 'p1', status: 'started' } },
  });
  await h.fsm.process(h.learner, text('next'));
  assert.equal(h.delivery.markLessonComplete.mock.callCount(), 1);
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 0);
});

test('stray "a" on an undelivered quiz-less lesson delivers it instead of skipping', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'd2m1' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { d2m1: { id: 'd2m1', content_type: 'text' } },
  });
  await h.fsm.process(h.learner, text('a'));
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 1);
  assert.equal(h.delivery.markLessonComplete.mock.callCount(), 0);
});

test('Continue Course from doubt state does not re-send an already delivered module', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'd1m2' };
  const h = setup({
    fsm: { state: 'doubt', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { d1m2: { id: 'd1m2', content_type: 'text' } },
    progress: { d1m2: { id: 'p', status: 'started' } },
  });
  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'next' });
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 0);
  assert.equal(h.delivery.markLessonComplete.mock.callCount(), 1);
});

// ── #16: day-end review answers are graded against their own question ────

test('bare A/B/C replies in a day-end review are graded against Q1, Q2, Q3 in turn', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'rev1' };
  const questions = [
    { id: 'q1', correct_answer: 'A', explanation: '' },
    { id: 'q2', correct_answer: 'C', explanation: '' },
    { id: 'q3', correct_answer: 'B', explanation: '' },
  ];
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { rev1: { id: 'rev1', content_type: 'review' } },
    quiz: { rev1: questions },
  });
  for (const letter of ['A', 'C', 'B']) {
    await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: letter });
  }
  const saved = h.calls['quiz.saveResponse'].map(([d]) => [d.questionId, d.answer, d.isCorrect]);
  assert.deepEqual(saved, [['q1', 'A', true], ['q2', 'C', true], ['q3', 'B', true]]);
  assert.ok(!h.sent.some((s) => s.body.includes('Not quite')));
});

test('day-end review sends one question at a time: the next only after each answer', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'rev1' };
  const questions = [
    { id: 'q1', correct_answer: 'A', explanation: '' },
    { id: 'q2', correct_answer: 'C', explanation: '' },
  ];
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { rev1: { id: 'rev1', content_type: 'review' } },
    quiz: { rev1: questions },
  });
  const sentQuiz = () => h.delivery.sendQuiz.mock.calls.map((c: any) => c.arguments[1].id);

  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'A' });
  assert.deepEqual(sentQuiz(), ['q2'], 'Q2 is sent after Q1 is answered');
  assert.ok(!h.sent.some((s) => s.buttons?.includes('next')), 'no continue prompt while a question is left');

  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'C' });
  assert.deepEqual(sentQuiz(), ['q2'], 'nothing more to send after the last question');
  assert.ok(h.sent.some((s) => s.buttons?.includes('next')), 'the continue prompt follows the last answer');
});

test('a regular module quiz still ends with the continue prompt, not another question', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm1' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { m1: { id: 'm1', content_type: 'text' } },
    quiz: { m1: [{ id: 'q1', correct_answer: 'B', explanation: '' }] },
  });
  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'B' });
  assert.equal(h.delivery.sendQuiz.mock.callCount(), 0);
  assert.ok(h.sent.some((s) => s.buttons?.includes('next')));
});

test('bare letter on a regular lesson grades against its (only shown) first question', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm1' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: { m1: { id: 'm1', content_type: 'text' } },
    quiz: { m1: [{ id: 'q1', correct_answer: 'B' }, { id: 'q9', correct_answer: 'A' }] },
  });
  await h.fsm.process(h.learner, text('b'));
  await h.fsm.process(h.learner, text('b'));
  assert.deepEqual(h.calls['quiz.saveResponse'].map(([d]) => d.questionId), ['q1', 'q1']);
});

// ── #21: "Ask Another" is not sent to the LLM ──────────────────────────────

test('doubt state: ask_question prompts for a question instead of querying the LLM', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm1' };
  const h = setup({
    fsm: { state: 'doubt', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
  });
  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'ask_question' });
  assert.equal(h.qa.handleTextQuestion.mock.callCount(), 0);
  assert.match(h.sent[0].body, /type your question/);
});

test('doubt state: question reaches QA with original text and without competing buttons', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm1' };
  const h = setup({
    fsm: { state: 'doubt', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
  });
  await h.fsm.process(h.learner, text('शेयर क्या होता है?'));
  const [, , question, options] = h.qa.handleTextQuestion.mock.calls[0].arguments as any[];
  assert.equal(question, 'शेयर क्या होता है?');
  assert.deepEqual(options, { followUpButtons: false });
  const prompt = h.sent.find((s) => s.kind === 'buttons');
  assert.deepEqual(prompt?.buttons, ['doubt_yes', 'next', 'no']);
});

// ── #20: non-ASCII input ────────────────────────────────────────────────────

test('a Hindi topic is accepted as-is', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: { language: 'hi' }, version: 3 } });
  await h.fsm.process(h.learner, text('शेयर मार्केट की बेसिक्स'));
  assert.equal(h.learner.metadata.fsm.state, 'style_input');
  assert.equal(h.learner.metadata.fsm.data.topic, 'शेयर मार्केट की बेसिक्स');
});

test('"C++" survives as a topic', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: {}, version: 3 } });
  await h.fsm.process(h.learner, text('C++'));
  assert.equal(h.learner.metadata.fsm.data.topic, 'C++');
});

test('typed हिंदी selects Hindi and typed आसान भाषा selects casual', async () => {
  const h = setup({ fsm: { state: 'language_input', data: {}, version: 3 } });
  await h.fsm.process(h.learner, text('हिंदी'));
  assert.equal(h.learner.metadata.fsm.data.language, 'hi');
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
  await h.fsm.process(h.learner, text('शेयर मार्केट की बेसिक्स'));
  await h.fsm.process(h.learner, text('आसान भाषा'));
  assert.equal(h.learner.metadata.fsm.state, 'goal_input');
  assert.equal(h.learner.metadata.fsm.data.style, 'casual');
});

test('every new course asks its style after the topic, and a stale style is not reused', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: { language: 'en', style: 'professional' }, version: 3 } });
  await h.fsm.process(h.learner, text('Farming Eggs'));
  assert.equal(h.learner.metadata.fsm.state, 'style_input');
  assert.equal(h.learner.metadata.fsm.data.style, undefined);
  await h.fsm.process(h.learner, text('style_practical'));
  assert.equal(h.learner.metadata.fsm.state, 'goal_input');
  assert.equal(h.learner.metadata.fsm.data.style, 'practical');
  assert.equal(h.learner.metadata.fsm.data.topic, 'Farming Eggs');
});

test('a button id from an older message is not taken as a topic', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: { language: 'en' }, version: 3 } });
  await h.fsm.process(h.learner, text('browse_courses'));
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
  assert.equal(h.learner.metadata.fsm.data.topic, undefined);
});

// ── #14: restart / new topic / New Course ───────────────────────────────────

test('"new topic" with an active course drops it and asks for a topic', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm3' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1', language: 'en' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
  });
  await h.fsm.process(h.learner, text('new topic'));
  assert.equal(h.enrollments.E1.status, 'dropped');
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 0);
});

test('"restart" with an active course resets to Day 1 Module 1', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', current_lesson_id: 'm3' };
  const h = setup({
    fsm: { state: 'learning', data: { enrollmentId: 'E1' }, version: 3 },
    activeEnrollment: enr,
    enrollments: { E1: enr },
    lessons: {
      m1: { id: 'm1', content_type: 'text' },
      m3: { id: 'm3', content_type: 'text' },
    },
  });
  await h.fsm.process(h.learner, text('restart'));
  assert.equal(h.enrollments.E1.current_lesson_id, 'm1');
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 1);
  assert.equal(h.learner.metadata.fsm.state, 'learning');
});

test('"New Course" button (id menu) after completion starts topic selection', async () => {
  const h = setup({ fsm: { state: 'complete', data: {}, version: 3 } });
  await h.fsm.process(h.learner, { from: 'tg:1', type: 'button', buttonReplyId: 'menu' });
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
});

test('"menu" during onboarding still shows help', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: {}, version: 3 } });
  await h.fsm.process(h.learner, text('menu'));
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
  assert.match(h.sent[0].body, /Here's what you can do/);
});

// ── #19: dynamic (M10) course escape hatches ────────────────────────────────

const m10Def = {
  fsm_json: {
    states: [{ id: 's', type: 'start' }, { id: 'l1', type: 'lesson' }, { id: 'e', type: 'end' }],
    transitions: [{ from: 's', to: 'l1', trigger: 'begin' }, { from: 'l1', to: 'e', trigger: 'done' }],
  },
};

test('M10: "menu" shows help instead of looping on the error', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', fsm_definition_id: 'F1' };
  const h = setup({ activeEnrollment: enr, enrollments: { E1: enr }, fsmDefinition: m10Def });
  await h.fsm.process(h.learner, text('menu'));
  assert.match(h.sent[0].body, /restart/);
  assert.ok(!h.sent.some((s) => s.body.includes('Something went wrong')));
});

test('M10: unmatched input re-prompts with the valid triggers', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', fsm_definition_id: 'F1' };
  const h = setup({ activeEnrollment: enr, enrollments: { E1: enr }, fsmDefinition: m10Def });
  await h.fsm.process(h.learner, text('hi'));
  assert.match(h.sent[0].body, /\*begin\*/);
});

test('M10: "new topic" drops the dynamic enrollment and asks for a topic', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', fsm_definition_id: 'F1' };
  const h = setup({ activeEnrollment: enr, enrollments: { E1: enr }, fsmDefinition: m10Def });
  await h.fsm.process(h.learner, text('new topic'));
  assert.equal(h.enrollments.E1.status, 'dropped');
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
});

// ── #2: authored progress is per enrollment ─────────────────────────────────

const authoredDef = {
  fsm_json: {
    startNodeId: 'screen_1',
    states: [
      { id: 'end_1', type: 'end' },
      { id: 'screen_1', type: 'screen', text: 'Welcome to Day 1' },
    ],
    transitions: [{ from: 'screen_1', to: 'end_1', trigger: 'next', label: 'Next' }],
  },
};

test('authored: state saved by a previous enrollment ("end_1") restarts the new course', async () => {
  const enr = { id: 'E2', course_id: 'C2', status: 'in_progress', fsm_definition_id: 'F2' };
  const h = setup({
    activeEnrollment: enr,
    enrollments: { E2: enr },
    fsmDefinition: authoredDef,
    dynamicSlot: { state: 'end_1', version: 7, enrollmentId: 'E1', fsmDefinitionId: 'F1' },
  });
  await h.fsm.process(h.learner, text('hi'));
  assert.equal(h.sent[0].body, 'Welcome to Day 1');
  assert.deepEqual(
    { ...h.learner.metadata.fsm_dynamic },
    { state: 'screen_1', version: 8, enrollmentId: 'E2', fsmDefinitionId: 'F2' },
  );
});

test('authored: legacy end state on a re-activated enrollment restarts instead of dead-ending', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', fsm_definition_id: 'F1' };
  const h = setup({
    activeEnrollment: enr,
    enrollments: { E1: enr },
    fsmDefinition: authoredDef,
    dynamicSlot: { state: 'end_1', version: 3 },
  });
  await h.fsm.process(h.learner, text('hi'));
  assert.equal(h.sent[0].body, 'Welcome to Day 1');
  assert.ok(!h.sent.some((s) => s.body.includes('Please use one of the buttons')));
});

test('authored: state saved for this enrollment still resumes', async () => {
  const enr = { id: 'E1', course_id: 'C1', status: 'in_progress', fsm_definition_id: 'F1' };
  const h = setup({
    activeEnrollment: enr,
    enrollments: { E1: enr },
    fsmDefinition: authoredDef,
    dynamicSlot: { state: 'screen_1', version: 3, enrollmentId: 'E1', fsmDefinitionId: 'F1' },
  });
  await h.fsm.process(h.learner, text('something else'));
  assert.match(h.sent[0].body, /Please use one of the buttons/);
});

// ── #15: late generation results never clobber newer state ─────────────────

test('a generation result arriving after the learner moved on is discarded', async () => {
  const h = setup({ fsm: { state: 'topic_input', data: {}, version: 9 } });
  (h.fsm as any).courseGenerator = { generate: async () => ({ id: 'C9', title: 'Old' }) };
  mock.method(db.organizations, 'getDefault', async () => ({ id: 'org' }));
  mock.method(db.lessons, 'findByCourse', async () => [{ id: 'x1' }]);
  await (h.fsm as any).generateCourseAsync(h.learner, { topic: 'Old', generationId: 'g-old' });
  assert.equal(h.calls['enrollments.create'], undefined);
  assert.equal(h.sent.length, 0);
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
});

test('a late generation failure does not send a second failure message', async () => {
  const h = setup({ fsm: { state: 'goal_input', data: { topic: 'New' }, version: 9 } });
  (h.fsm as any).courseGenerator = { generate: async () => { throw new Error('LLM exploded'); } };
  mock.method(db.organizations, 'getDefault', async () => ({ id: 'org' }));
  await (h.fsm as any).generateCourseAsync(h.learner, { topic: 'Old', generationId: 'g-old' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.learner.metadata.fsm.state, 'goal_input');
});

test('the current generation enrolls the learner and starts the course', async () => {
  const h = setup({ fsm: { state: 'generating', data: { topic: 'Py', generationId: 'g1' }, version: 9 } });
  (h.fsm as any).courseGenerator = { generate: async () => ({ id: 'C9', title: 'Py' }) };
  mock.method(db.organizations, 'getDefault', async () => ({ id: 'org' }));
  mock.method(db.lessons, 'findByCourse', async () => [{ id: 'x1' }]);
  mock.method(db.flashcardProgress, 'enqueueForLearner', async () => 0);
  await (h.fsm as any).generateCourseAsync(h.learner, { topic: 'Py', generationId: 'g1' });
  assert.equal(h.calls['enrollments.create'].length, 1);
  assert.equal(h.learner.metadata.fsm.state, 'learning');
  assert.equal(h.delivery.sendNextLesson.mock.callCount(), 1);
});

test('a reused course with no lessons is not enrolled', async () => {
  const h = setup({ fsm: { state: 'generating', data: { topic: 'DT', generationId: 'g1' }, version: 9 } });
  (h.fsm as any).courseGenerator = { generate: async () => ({ id: 'C9', title: 'Design Thinking' }) };
  mock.method(db.organizations, 'getDefault', async () => ({ id: 'org' }));
  mock.method(db.lessons, 'findByCourse', async () => []);
  await (h.fsm as any).generateCourseAsync(h.learner, { topic: 'DT', generationId: 'g1' });
  assert.equal(h.calls['enrollments.create'], undefined);
  assert.equal(h.learner.metadata.fsm.state, 'topic_input');
  assert.match(h.sent[0].body, /trouble generating/);
});
