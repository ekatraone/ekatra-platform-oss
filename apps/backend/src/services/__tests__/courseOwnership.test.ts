/** Courses generated for a learner are stamped with requestedByLearnerId; admin/API generation never is. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseGeneratorService, buildCourseSettings } from '../courseGenerator.js';
import { requestLesson } from '../syncService.js';
import { courseRequestFor } from '../../flows/conversationFSM.js';
import { makeAuthDb } from '../../routes/__tests__/fakeAuthDb.js';

const LEARNER = '00000000-0000-4000-8000-0000000000b1';
const ORG = '00000000-0000-4000-8000-0000000000aa';

test('buildCourseSettings stamps requestedByLearnerId only when one is given', () => {
  const course = { days: [{}] };
  assert.equal(buildCourseSettings(course, 'en', 'micro', undefined, LEARNER).requestedByLearnerId, LEARNER);
  assert.ok(!('requestedByLearnerId' in buildCourseSettings(course, 'en', 'micro')), 'admin/API generation sets no owner');
});

test('generate() passes the requesting learner through to the saved course', async () => {
  const svc: any = new CourseGeneratorService();
  const saved: any[] = [];
  svc.findExistingCourse = async () => null;
  svc.callLLM = async () => ({ title: 't', description: 'd', days: [] });
  svc.saveToDB = async (...args: any[]) => { saved.push(args); return { id: 'c' }; };
  await svc.generate({ topic: 'x', organizationId: 'o', requestedByLearnerId: LEARNER });
  await svc.generate({ topic: 'x', organizationId: 'o' });
  assert.equal(saved[0][6], LEARNER);
  assert.equal(saved[1][6], undefined);
});

test('the sync lesson request asks the generator for a course owned by the requesting learner', async () => {
  const params: any[] = [];
  const db: any = makeAuthDb();
  const raw = db.raw.bind(db);
  db.raw = async (sql: string, p: any[]) => {
    if (sql.includes('INSERT INTO sync_lesson_requests')) return { rows: [{ attempt: 1 }] };
    if (sql.includes("UPDATE sync_lesson_requests SET status = 'done'")) return { rows: [{ attempt: 1 }] };
    return raw(sql, p);
  };
  await requestLesson(db, { generate: async (x) => { params.push(x); throw new Error('stop here'); } }, { id: LEARNER, organizationId: ORG },
    { topic: 'Compound interest', clientRequestId: '00000000-0000-4000-8000-0000000000e9' }).catch(() => undefined);
  assert.equal(params[0].requestedByLearnerId, LEARNER);
});

test('the WhatsApp chat flow asks the generator for a course owned by the chatting learner', () => {
  const req = courseRequestFor({ id: LEARNER, language: 'hi', organization_id: ORG }, { topic: 'Python', goal: 'jobs', style: 'casual' } as any, undefined);
  assert.equal(req.requestedByLearnerId, LEARNER);
  assert.deepEqual({ topic: req.topic, goal: req.goal, language: req.language, organizationId: req.organizationId },
    { topic: 'Python', goal: 'jobs', language: 'hi', organizationId: ORG });
  assert.equal(courseRequestFor({ id: LEARNER, organization_id: ORG }, { topic: 'x' } as any, 'default-org').organizationId, 'default-org');
});
