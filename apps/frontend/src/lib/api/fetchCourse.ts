import { api } from '@/services/apiClient';
import { mapCourse } from './courseMapper';
export const fetchCourse = async (id: number | string) => mapCourse((await api.getCourse(String(id))).data);
