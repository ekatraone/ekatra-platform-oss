
import { Course, CourseDay } from "../types";
import { api } from "@/services/apiClient";

// Reconstruct frontend day/paragraph model from flat lessons array returned by backend
function lessonsToDays(lessons: any[]): CourseDay[] {
  if (!lessons || lessons.length === 0) return [];
  const dayMap = new Map<number, CourseDay>();
  for (const lesson of lessons) {
    const dayNum: number = lesson.day_number ?? lesson.dayNumber ?? 1;
    if (!dayMap.has(dayNum)) {
      dayMap.set(dayNum, { id: dayNum, title: `Day ${dayNum}`, paragraphs: [], media: undefined });
    }
    const day = dayMap.get(dayNum)!;
    day.paragraphs.push({
      id: day.paragraphs.length + 1,
      content: lesson.content || '',
      lessonId: lesson.id,
    });
    if (lesson.media_url || lesson.mediaUrl) {
      day.media = lesson.media_url || lesson.mediaUrl;
    }
  }
  return Array.from(dayMap.values()).sort((a, b) => a.id - b.id);
}

// Fetch a single course by ID
export const fetchCourse = async (id: number | string): Promise<Course> => {
  const response = await api.getCourse(id.toString());
  const course = (response as any).data ?? response;
  const lessons: any[] = course.lessons ?? [];

  return {
    id: course.id,
    title: course.title || '',
    instructor: course.instructor || '',
    description: course.description || '',
    category: course.category || '',
    language: course.language || '',
    price: course.price || 0,
    enrolled: course.enrolledCount || 0,
    completion: 0,
    status: course.status,
    created: course.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0],
    days: lessonsToDays(lessons),
    fsm_definition_id: course.fsm_definition_id,
  };
};
