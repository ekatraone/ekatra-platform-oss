import type { CourseDay } from '../types';
import type { LessonRecord } from '../../services/contracts';

/** Validate the whole edit before writes; never infer lesson identity from position. */
export function planLessons(days: CourseDay[], existing: LessonRecord[]) {
  const available = new Set(existing.map(lesson => lesson.id));
  const retained = new Set<string>();
  const plan = days.flatMap((day, dayIndex) => day.paragraphs.map((paragraph, index) => {
    if (paragraph.lessonId) {
      if (!available.has(paragraph.lessonId) || retained.has(paragraph.lessonId)) {
        throw new Error('Course content has changed. Reload the course before saving.');
      }
      retained.add(paragraph.lessonId);
    }
    if (!paragraph.content.trim()) {
      throw new Error('Each lesson needs content. Remove empty new paragraphs before saving.');
    }
    return {
      id: paragraph.lessonId,
      data: {
        title: index === 0 ? day.title || `Day ${dayIndex + 1}` : `Day ${dayIndex + 1} — Part ${index + 1}`,
        content: paragraph.content,
        mediaUrl: index === 0 ? day.media : undefined,
        dayNumber: dayIndex + 1,
        sequenceOrder: 0,
      },
    };
  }));
  if (existing.some(lesson => !retained.has(lesson.id))) {
    throw new Error('Removing saved lessons is not supported here because it can erase learner progress. Keep the lessons or create a separate course.');
  }
  return plan.map((lesson, index) => ({ ...lesson, data: { ...lesson.data, sequenceOrder: index + 1 } }));
}
