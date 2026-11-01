import { api } from '@/services/apiClient';
import { fetchCourse } from './fetchCourse';
export const archiveCourse = async (id: number | string) => {
  await api.updateCourse(String(id), { status: 'archived' });
  return fetchCourse(id);
};
