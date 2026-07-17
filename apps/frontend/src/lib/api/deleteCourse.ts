
import { api } from "@/services/apiClient";

// Delete a course
export const deleteCourse = async (id: number | string): Promise<void> => {
  try {
    await api.deleteCourse(id.toString());
  } catch (error) {
    console.error(`Error deleting course ${id}:`, error);
    throw new Error(`Failed to delete course: ${(error as Error).message}`);
  }
};
