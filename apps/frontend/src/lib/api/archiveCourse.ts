
import { Course } from "../types";
import { api } from "@/services/apiClient";

// Archive a course
export const archiveCourse = async (id: number | string): Promise<Course> => {
  try {
    // Update status to archived
    const archivedCourse = await api.updateCourse(id.toString(), { status: 'archived' });
    
    return {
      id: archivedCourse.id,
      title: archivedCourse.title || "",
      instructor: archivedCourse.instructor || "",
      description: archivedCourse.description || "",
      category: archivedCourse.category || "",
      language: archivedCourse.language || "",
      price: archivedCourse.price || 0,
      enrolled: archivedCourse.enrolledCount || 0,
      completion: 0,
      status: archivedCourse.status,
      created: archivedCourse.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0],
      days: archivedCourse.days || []
    };
  } catch (error) {
    console.error(`Error archiving course ${id}:`, error);
    throw new Error(`Failed to archive course: ${(error as Error).message}`);
  }
};
