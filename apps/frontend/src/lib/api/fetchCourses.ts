
import { Course } from "../types";
import { api } from "@/services/apiClient";

// Fetch all courses
export const fetchCourses = async (): Promise<Course[]> => {
  const response = await api.getCourses({ status: undefined, limit: 100 });

  return response.data.map((course: any) => ({
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
    days: course.days || [],
    fsm_definition_id: course.fsm_definition_id,
  }));
};
