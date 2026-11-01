import { api } from '@/services/apiClient';
import { mapCourse } from './courseMapper';
import { fetchAllPages } from './pagination';
import type { CourseRecord } from '../../services/contracts';

/** Every course record (all pages), optionally filtered by status — for lists and pickers. */
export const fetchAllCourseRecords = (params?: { status?: string }) =>
  fetchAllPages<CourseRecord>((page, limit) => api.getCourses({ ...params, page, limit }) as any);

export const fetchCourses = async () => (await fetchAllCourseRecords()).map(mapCourse);
