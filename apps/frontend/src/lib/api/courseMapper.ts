import type { Course, CourseDay } from '../types';
import type { CourseRecord } from '../../services/contracts';

/** Convert the API's snake_case records at a single UI boundary. */
export function mapCourse(record: CourseRecord): Course {
  const days = new Map<number, CourseDay>();
  for (const lesson of record.lessons || []) {
    const number = lesson.day_number ?? 1;
    const day = days.get(number) || { id: number, title: lesson.title || `Day ${number}`, paragraphs: [] };
    day.paragraphs.push({ id: day.paragraphs.length + 1, content: lesson.content || '', lessonId: lesson.id });
    if (lesson.media_url) day.media = lesson.media_url;
    days.set(number, day);
  }
  return {
    id: record.id, title: record.title, instructor: record.settings?.instructor ?? record.instructor ?? '',
    description: record.description || '', category: record.category || '', language: record.settings?.language ?? record.language ?? '',
    price: record.settings?.price ?? record.price ?? 0, enrolled: record.enrolled_count || 0, completion: record.completion_rate || 0,
    status: record.status === 'published' ? 'active' : record.status,
    created: record.created_at?.split('T')[0] || '',
    days: [...days.values()].sort((a, b) => a.id - b.id),
    fsm_definition_id: record.fsm_definition_id, source: record.source,
  };
}
