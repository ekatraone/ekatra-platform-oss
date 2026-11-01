import { api } from '@/services/apiClient';
import { fetchCourse } from './fetchCourse';
export const publishCourse = async (id: number | string) => {
  await api.publishCourse(String(id));
  return fetchCourse(id);
};
