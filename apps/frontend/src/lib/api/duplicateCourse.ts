
import { Course } from "../types";
import { api } from "@/services/apiClient";

// Duplicate a course
export const duplicateCourse = async (id: number | string): Promise<Course> => {
  try {
    const duplicatedCourse = await api.duplicateCourse(id.toString());
    
    return {
      id: duplicatedCourse.id,
      title: duplicatedCourse.title || "",
      instructor: duplicatedCourse.instructor || "",
      description: duplicatedCourse.description || "",
      category: duplicatedCourse.category || "",
      language: duplicatedCourse.language || "",
      price: duplicatedCourse.price || 0,
      enrolled: 0,
      completion: 0,
      status: "draft",
      created: new Date().toISOString().split('T')[0],
      days: duplicatedCourse.days || []
    };
  } catch (error) {
    console.error(`Error duplicating course ${id}:`, error);
    throw new Error(`Failed to duplicate course: ${(error as Error).message}`);
  }
};
