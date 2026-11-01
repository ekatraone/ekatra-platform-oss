/**
 * M13a — learner profile math against the dummy fixture trail (AC1)
 * and the never-block event recorder guarantee (AC1b).
 *
 * Fixture: 16 events over 2 learner-local days — 12 quiz answers
 * (8 correct, 4 wrong; L2 gets wrong→correct→wrong), 4 lessons completed,
 * timestamps at 09:xx and 19:xx IST (stored as UTC, learner tz unset).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeProfile, recordLearnerEvent, resolveTimezone, LearnerEvent } from '../learnerProfile.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/learnerEventsTrail.json',
);
const trail: LearnerEvent[] = JSON.parse(readFileSync(fixturePath, 'utf-8'));

test('AC1: mastery(L2) is 0.33±0.01 under documented recency weighting', () => {
  const p = computeProfile(trail, null);
  // L2 attempts wrong→correct→wrong, weights 0.81/0.9/1.0 → 0.9/2.71 ≈ 0.3321
  assert.ok(Math.abs(p.mastery['L2'] - 0.33) <= 0.01, `mastery L2 = ${p.mastery['L2']}`);
});

test('AC1: struggle list is exactly [L2]', () => {
  const p = computeProfile(trail, null);
  assert.deepEqual(p.struggles, ['L2']);
});

test('AC1: modal hours are {9, 19} learner-local (IST default when tz unset)', () => {
  const p = computeProfile(trail, null);
  assert.deepEqual(p.preferredHours, [9, 19]);
  assert.equal(p.hourHistogram['9'], 8);
  assert.equal(p.hourHistogram['19'], 8);
});

test('AC1: velocity matches fixture lessons/day (4 lessons over 2 active days)', () => {
  const p = computeProfile(trail, null);
  assert.equal(p.velocity, 2);
});

test('AC1: totals pinned — 16 events, 12 quiz (8 correct, 4 wrong), 4 lessons', () => {
  const p = computeProfile(trail, null);
  assert.deepEqual(p.totals, {
    events: 16,
    quizAnswered: 12,
    correct: 8,
    wrong: 4,
    lessonsCompleted: 4,
  });
});

test('mastery of other lessons follows the same weighting', () => {
  const p = computeProfile(trail, null);
  // L1 correct,correct,wrong → (0.81+0.9)/2.71 ≈ 0.631
  assert.ok(Math.abs(p.mastery['L1'] - 0.631) <= 0.01, `L1 = ${p.mastery['L1']}`);
  // L4 all correct → 1
  assert.equal(p.mastery['L4'], 1);
});

test('timezone: unset and schema-default UTC both resolve to Asia/Kolkata; explicit tz honored', () => {
  assert.equal(resolveTimezone(undefined), 'Asia/Kolkata');
  assert.equal(resolveTimezone(null), 'Asia/Kolkata');
  assert.equal(resolveTimezone('UTC'), 'Asia/Kolkata');
  assert.equal(resolveTimezone('Europe/London'), 'Europe/London');

  // 03:35Z in September is 04:35 in London (BST) — histogram shifts accordingly.
  const p = computeProfile(trail, 'Europe/London');
  assert.deepEqual(p.preferredHours, [4, 14]);
});

test('timezone: an invalid tz string falls back to the default instead of throwing', () => {
  const p = computeProfile(trail, 'Not/AZone');
  assert.deepEqual(p.preferredHours, [9, 19]);
});

test('replayed lesson_completed events (re-import re-delivery) are counted once', () => {
  // Duplicate every lesson_completed in the trail — velocity and totals must not move.
  const replayed = [
    ...trail,
    ...trail
      .filter((e) => e.type === 'lesson_completed')
      .map((e) => ({ ...e, created_at: '2026-09-30T03:35:00Z' })),
  ];
  const p = computeProfile(replayed, null);
  assert.equal(p.totals.lessonsCompleted, 4);
  // 3 active days now (replay day added), 4 unique lessons → velocity drops accordingly.
  assert.equal(p.velocity, Number((4 / 3).toFixed(4)));
});

test('AC1b: recordLearnerEvent never throws when the event write fails', async () => {
  const failingDb = {
    learnerEvents: {
      create: async () => { throw new Error('db down'); },
      findByLearner: async () => { throw new Error('db down'); },
      updateLearnerProfile: async () => { throw new Error('db down'); },
    },
  };
  await assert.doesNotReject(
    recordLearnerEvent(
      { learnerId: 'learner-1', type: 'quiz_answered', payload: { correct: true } },
      failingDb,
    ),
  );
});

test('recordLearnerEvent happy path: writes the event and persists a recomputed profile', async () => {
  const stored: any = { events: [] as any[], profile: null };
  const stubDb = {
    learnerEvents: {
      create: async (data: any) => {
        stored.events.push({
          type: data.type,
          node_id: data.nodeId,
          payload: data.payload,
          created_at: '2026-09-29T03:35:00Z',
        });
        return stored.events[stored.events.length - 1];
      },
      findByLearner: async () => stored.events,
      updateLearnerProfile: async (_id: string, profile: any) => {
        stored.profile = profile;
        return { id: _id };
      },
    },
  };
  await recordLearnerEvent(
    { learnerId: 'learner-1', nodeId: 'L9', type: 'quiz_answered', payload: { correct: false } },
    stubDb,
  );
  assert.equal(stored.events.length, 1);
  assert.equal(stored.profile.totals.quizAnswered, 1);
  assert.equal(stored.profile.totals.wrong, 1);
  assert.equal(stored.profile.mastery['L9'], 0);
});
