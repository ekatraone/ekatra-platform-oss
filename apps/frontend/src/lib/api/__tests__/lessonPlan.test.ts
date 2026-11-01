import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLessons } from '../lessonPlan';
import { mapCourse } from '../courseMapper';

const existing = [{ id: 'lesson-a', title: 'Introduction' }, { id: 'lesson-b', title: 'Practice' }];
test('reordering and editing retain persisted lesson IDs', () => {
  const plan = planLessons([{ id: 1, title: 'Day one', paragraphs: [
    { id: 1, lessonId: 'lesson-b', content: 'Revised practice' },
    { id: 2, lessonId: 'lesson-a', content: 'Introduction' },
    { id: 3, content: 'New lesson' },
  ] }], existing);
  assert.deepEqual(plan.map(row => [row.id, row.data.sequenceOrder]), [['lesson-b', 1], ['lesson-a', 2], [undefined, 3]]);
  assert.equal(plan[0].data.content, 'Revised practice');
});
test('removing existing lessons is rejected before saving', () => {
  assert.throws(() => planLessons([], existing), /Removing saved lessons/);
});
test('unknown or duplicate identities and blank content are rejected', () => {
  for (const paragraphs of [
    [{ id: 1, lessonId: 'unknown', content: 'text' }],
    [{ id: 1, lessonId: 'lesson-a', content: 'text' }, { id: 2, lessonId: 'lesson-a', content: 'text' }],
    [{ id: 1, lessonId: 'lesson-a', content: '   ' }],
  ]) assert.throws(() => planLessons([{ id: 1, title: 'Day', paragraphs }], existing));
});
test('saved settings, day titles and lesson identities survive mapping', () => {
  const mapped = mapCourse({ id: 'course', title: 'Course', status: 'published',
    settings: { instructor: 'Teacher', language: 'Hindi', price: 0 }, lessons: existing });
  assert.equal(mapped.instructor, 'Teacher');
  assert.equal(mapped.language, 'Hindi');
  assert.equal(mapped.days?.[0].title, 'Introduction');
  assert.equal(mapped.days?.[0].paragraphs[1].lessonId, 'lesson-b');
  assert.equal(mapped.status, 'active');
});
