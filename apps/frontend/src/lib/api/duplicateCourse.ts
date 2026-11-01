import { api } from '@/services/apiClient';
import { fetchCourse } from './fetchCourse';
export const duplicateCourse = async (id: number | string) => {
  const { data } = await api.duplicateCourse(String(id));
  return fetchCourse(data.id);
};
