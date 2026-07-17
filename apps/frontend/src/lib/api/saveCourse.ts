
import { Course } from "../types";
import { api } from "@/services/apiClient";

// Save a course (create or update metadata, then sync lessons from days)
export const saveCourse = async (course: Course): Promise<Course> => {
  const isExisting = course.id && course.id.length > 20;

  // 1. Create or update course metadata
  const courseData = {
    title: course.title,
    description: course.description,
    category: course.category,
    status: course.status,
    fsm_definition_id: course.fsm_definition_id,
    settings: {
      instructor: course.instructor,
      language: course.language,
      price: course.price,
    },
  };

  let savedCourse: any;
  if (isExisting) {
    savedCourse = await api.updateCourse(course.id, courseData);
  } else {
    savedCourse = await api.createCourse({ ...courseData, title: course.title });
  }

  const courseId: string = (savedCourse.data ?? savedCourse).id ?? course.id;

  // 2. Delete all existing lessons so we can replace with current day/paragraph content
  try {
    const existingResp: any = await api.getLessons(courseId);
    const existingLessons: any[] = (existingResp.data ?? existingResp) || [];
    for (const lesson of existingLessons) {
      await api.deleteLesson(courseId, lesson.id);
    }
  } catch {
    // New course — no existing lessons
  }

  // 3. Re-create one lesson row per paragraph per day
  const days = course.days || [];
  let sequenceOrder = 1;
  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const day = days[dayIdx];
    const dayNumber = dayIdx + 1;
    for (let pIdx = 0; pIdx < (day.paragraphs || []).length; pIdx++) {
      const para = day.paragraphs[pIdx];
      if (!para.content?.trim()) continue;
      await api.createLesson(courseId, {
        title: pIdx === 0 ? (day.title || `Day ${dayNumber}`) : `Day ${dayNumber} — Part ${pIdx + 1}`,
        content: para.content,
        contentType: 'text',
        mediaUrl: pIdx === 0 ? day.media : undefined,
        dayNumber,
        sequenceOrder,
      });
      sequenceOrder++;
    }
  }

  // 4. Return normalised course back to UI
  const result = savedCourse.data ?? savedCourse;
  return {
    id: courseId,
    title: result.title || course.title,
    instructor: result.settings?.instructor ?? course.instructor ?? '',
    description: result.description || course.description || '',
    category: result.category || course.category || '',
    language: result.settings?.language ?? course.language ?? '',
    price: result.settings?.price ?? course.price ?? 0,
    enrolled: result.enrolledCount || 0,
    completion: 0,
    status: result.status || course.status,
    created: result.createdAt?.split('T')[0] || course.created,
    days: course.days || [],
    fsm_definition_id: result.fsm_definition_id ?? course.fsm_definition_id,
  };
};
