import type { Course } from '../types';
import { api } from '@/services/apiClient';
import { mapCourse } from './courseMapper';
import { planLessons } from './lessonPlan';

type SaveCourseClient = Pick<typeof api,
  'getLessons' | 'createCourse' | 'updateCourse' | 'getCourse' | 'createLesson' | 'updateLesson'>;

// Drafts get a client-side UUID too, so the id shape cannot tell new from existing:
// the caller must say whether this course came from the server.
export const saveCourse = async (
  course: Course,
  { isNew }: { isNew: boolean },
  client: SaveCourseClient = api,
): Promise<Course> => {
  const isExisting = !isNew;
  // A failed read must abort the save, rather than being mistaken for an empty course.
  const existing = isExisting ? (await client.getLessons(course.id)).data : [];
  const lessons = planLessons(course.days || [], existing);
  const courseData = {
    title: course.title,
    description: course.description,
    category: course.category,
    status: course.status === 'active' ? 'published' : course.status,
    fsm_definition_id: course.fsm_definition_id,
    settings: { instructor: course.instructor, language: course.language, price: course.price },
  };
  const saved = isExisting
    ? await client.updateCourse(course.id, courseData)
    : await client.createCourse(courseData);
  const courseId = saved.data.id;
  for (const lesson of lessons) {
    if (lesson.id) {
      await client.updateLesson(courseId, lesson.id, lesson.data);
    } else {
      await client.createLesson(courseId, { ...lesson.data, contentType: 'text' });
    }
  }
  return mapCourse((await client.getCourse(courseId)).data);
};
