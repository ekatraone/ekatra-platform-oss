
import { Course } from "../types";
import { api } from "@/services/apiClient";

// Publish a course
export const publishCourse = async (id: number | string): Promise<Course> => {
  try {
    const publishedCourse = await api.publishCourse(id.toString());
    
    return {
      id: publishedCourse.id,
      title: publishedCourse.title || "",
      instructor: publishedCourse.instructor || "",
      description: publishedCourse.description || "",
      category: publishedCourse.category || "",
      language: publishedCourse.language || "",
      price: publishedCourse.price || 0,
      enrolled: publishedCourse.enrolledCount || 0,
      completion: 0,
      status: publishedCourse.status,
      created: publishedCourse.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0],
      days: publishedCourse.days || []
    };
  } catch (error) {
    console.error(`Error publishing course ${id}:`, error);
    throw new Error(`Failed to publish course: ${(error as Error).message}`);
  }
};
