
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/apiClient";

interface CourseStats {
  name: string;
  enrolled: number;
  completion: number;
}

export const useCourseStats = () => {
  return useQuery({
    queryKey: ["course-stats"],
    queryFn: async (): Promise<CourseStats[]> => {
      try {
        const response = await apiClient.get('/api/courses/stats');
        const courses = response.data || [];

        return courses.map((course: any) => ({
          name: course.title || course.name,
          enrolled: course.enrolled || 0,
          completion: course.completion || 0
        }));
      } catch (error) {
        console.error("Error fetching course stats:", error);
        return [];
      }
    }
  });
};
