import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveCourse } from '../saveCourse';
import type { Course } from '../../types';

function fakeClient() {
  const calls: string[] = [];
  const record = { id: 'server-id', title: 'Draft', status: 'draft', lessons: [] };
  const client = {
    getLessons: async (id: string) => { calls.push(`getLessons:${id}`); throw new Error('Course not found'); },
    createCourse: async () => { calls.push('createCourse'); return { success: true, data: record }; },
    updateCourse: async (id: string) => { calls.push(`updateCourse:${id}`); return { success: true, data: record }; },
    createLesson: async (courseId: string) => { calls.push(`createLesson:${courseId}`); return { success: true, data: {} }; },
    updateLesson: async () => { calls.push('updateLesson'); return { success: true, data: {} }; },
    getCourse: async () => ({ success: true, data: record }),
  };
  return { calls, client: client as any };
}

const draft: Course = {
  id: '3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b', title: 'Draft', description: '', status: 'draft',
  days: [{ id: 1, title: 'Day 1', paragraphs: [{ id: 1, content: 'Hello' }] }],
} as Course;

test('a new course with a client-side UUID is created, not looked up', async () => {
  const { calls, client } = fakeClient();
  const saved = await saveCourse(draft, { isNew: true }, client);
  assert.deepEqual(calls, ['createCourse', 'createLesson:server-id']);
  assert.equal(saved.id, 'server-id');
});

test('an existing course reads its lessons first and aborts when that read fails', async () => {
  const { calls, client } = fakeClient();
  await assert.rejects(saveCourse(draft, { isNew: false }, client), /Course not found/);
  assert.deepEqual(calls, [`getLessons:${draft.id}`]);
});
