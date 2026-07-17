import { Course, CourseDay, CourseParagraph } from "../types";
import { api } from "@/services/apiClient";

// Helper to convert database course format to application format
export const dbCourseToAppCourse = (dbCourse: any, days: any[] = []): Course => {
  // Handle lessons format (new schema) or days format (legacy)
  const courseDays = days.map((day, idx) => ({
    id: day.id || day.day_number || idx + 1,
    title: day.title,
    paragraphs: day.content 
      ? [{ id: 1, content: day.content }] // New lesson format
      : (day.paragraphs?.map((para: any) => ({
          id: para.paragraph_number || para.id,
          content: para.content
        })) || []),
    media: day.media_url || day.media
  }));

  return {
    id: dbCourse.id,
    title: dbCourse.title,
    instructor: dbCourse.instructor || dbCourse.created_by || "",
    description: dbCourse.description || "",
    category: dbCourse.category || "",
    language: dbCourse.language || "",
    price: dbCourse.price || 0,
    enrolled: dbCourse.enrolled_count || 0,
    completion: dbCourse.completion_rate || 0,
    status: dbCourse.status === 'published' ? "active" : "draft",
    created: new Date(dbCourse.created_at).toISOString().split('T')[0],
    days: courseDays,
  };
};

// Helper to prepare course for database insertion
export const appCourseToDbFormat = (course: Course) => {
  const courseId = course.id || crypto.randomUUID();

  const courseData = {
    id: courseId,
    title: course.title || "",
    description: course.description || "",
    category: course.category || "",
    status: course.status === "active" ? "published" : "draft"
  };

  // Convert days to lessons format
  const lessons = (course.days || []).map((day, idx) => ({
    title: day.title || `Lesson ${idx + 1}`,
    content: day.paragraphs?.map(p => p.content).join('\n\n') || '',
    contentType: 'text',
    mediaUrl: day.media,
    sequenceOrder: idx + 1
  }));

  return { courseData, lessons };
};

// Check if user is authenticated
export const checkAuth = async () => {
  const token = localStorage.getItem('auth_token');
  const user = localStorage.getItem('user');
  
  if (!token || !user) {
    throw new Error("User not authenticated. Please sign in.");
  }
  
  return JSON.parse(user);
};
