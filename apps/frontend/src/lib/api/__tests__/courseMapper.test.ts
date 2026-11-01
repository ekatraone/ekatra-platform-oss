import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCourse } from '../courseMapper';

test('published course maps real timestamps, status and stable lesson IDs', () => {
  const course = mapCourse({
    id: 'course-1', title: 'Course', status: 'published', created_at: '2026-09-15T10:00:00Z',
    enrolled_count: 4, source: 'authored',
    lessons: [
      { id: 'lesson-2', title: 'Second', day_number: 2, content: 'Two' },
      { id: 'lesson-1', title: 'First', day_number: 1, content: 'One', media_url: 'https://example.test/image.png' },
    ],
  });
  assert.equal(course.status, 'active');
  assert.equal(course.created, '2026-09-15');
  assert.equal(course.enrolled, 4);
  assert.deepEqual(course.days?.map(day => day.id), [1, 2]);
  assert.equal(course.days?.[0].paragraphs[0].lessonId, 'lesson-1');
  assert.equal(course.days?.[0].media, 'https://example.test/image.png');
});
test('archived status is preserved and missing creation time is not invented', () => {
  const course = mapCourse({ id: 'course-2', title: 'Archived', status: 'archived' });
  assert.equal(course.status, 'archived');
  assert.equal(course.created, '');
  assert.deepEqual(course.days, []);
});
