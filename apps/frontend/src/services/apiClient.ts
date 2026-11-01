/**
 * Ekatra Backend API Client
 * Replaces Supabase with our own backend API
 */

import type { ApiResult, CourseRecord, LessonRecord, StatsRecord, MessageRecord } from './contracts';

// FSM types shared between apiClient and FSMEditor.
// start/lesson/question/end are editor-authored (M10); screen/choice/quiz/day_end
// come from the authored-course importer (M12) and carry their content inline.
export interface FSMState {
  id: string;
  type: 'start' | 'lesson' | 'question' | 'end' | 'screen' | 'choice' | 'quiz' | 'day_end';
  label?: string;
  data?: Record<string, unknown>;
  // Authored-course node content (importAuthoredCourse.ts)
  day?: number;
  moduleNumber?: number;
  text?: string;
  fileUrl?: string;
  fileName?: string;
  mediaMissing?: boolean;
  link?: string;
  question?: string;
  options?: { id: string; label: string; correct?: boolean }[];
}

export interface FSMTransition {
  id?: string;
  from: string;
  to: string;
  condition?: string;
  label?: string;
  /** Authored-course transitions: normalized reply text that fires this edge ('__auto__' = no user input needed) */
  trigger?: string;
}

export interface FSMJson {
  states: FSMState[];
  transitions: FSMTransition[];
  /** Present on imported authored courses — also the marker that makes the editor view-only */
  startNodeId?: string;
}

export interface FSMListItem {
  id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface FSMDefinition extends FSMListItem {
  organization_id: string;
  fsm_json: FSMJson;
  created_by: string | null;
}

const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:3001';
const AUTH_STORAGE_KEY = 'ekatra_auth';

class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = API_URL;
  }

  private getAuthToken(): string | null {
    const directToken = localStorage.getItem('auth_token');
    if (directToken) return directToken;

    const authBlob = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!authBlob) return null;

    try {
      const parsed = JSON.parse(authBlob);
      return typeof parsed?.token === 'string' ? parsed.token : null;
    } catch {
      return null;
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    };

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // Courses
  async getCourses(params?: { status?: string; search?: string; page?: number; limit?: number }) {
    const defined = Object.fromEntries(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null)
    );
    const query = new URLSearchParams(defined as any).toString();
    return this.request<ApiResult<CourseRecord[]>>(`/api/courses${query ? `?${query}` : ''}`);
  }

  async getCourse(id: string) {
    return this.request<ApiResult<CourseRecord>>(`/api/courses/${id}`);
  }

  async createCourse(data: any) {
    return this.request<ApiResult<CourseRecord>>('/api/courses', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateCourse(id: string, data: any) {
    return this.request<ApiResult<CourseRecord>>(`/api/courses/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteCourse(id: string) {
    return this.request(`/api/courses/${id}`, { method: 'DELETE' });
  }

  async publishCourse(id: string) {
    return this.request<ApiResult<CourseRecord>>(`/api/courses/${id}/publish`, { method: 'POST' });
  }

  async unpublishCourse(id: string) {
    return this.request(`/api/courses/${id}/unpublish`, { method: 'POST' });
  }

  async duplicateCourse(id: string, newTitle?: string) {
    return this.request<ApiResult<CourseRecord>>(`/api/courses/${id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ newTitle }),
    });
  }

  // Course Lessons (static course content)
  async getLessons(courseId: string) {
    return this.request<ApiResult<LessonRecord[]>>(`/api/courses/${courseId}/lessons`);
  }

  async createLesson(courseId: string, data: {
    title: string; content?: string; contentType?: string;
    mediaUrl?: string; dayNumber?: number; sequenceOrder?: number;
  }) {
    return this.request(`/api/courses/${courseId}/lessons`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateLesson(courseId: string, lessonId: string, data: any) {
    return this.request(`/api/courses/${courseId}/lessons/${lessonId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteLesson(courseId: string, lessonId: string) {
    return this.request(`/api/courses/${courseId}/lessons/${lessonId}`, { method: 'DELETE' });
  }

  // Learners
  async getLearners(params?: { courseId?: string; status?: string; search?: string; page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/api/learners${query ? `?${query}` : ''}`);
  }

  async getLearner(id: string) {
    return this.request(`/api/learners/${id}`);
  }

  async createLearner(data: any) {
    return this.request('/api/learners', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateLearner(id: string, data: any) {
    return this.request(`/api/learners/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async enrollLearner(id: string, courseId: string, startImmediately = false) {
    return this.request(`/api/learners/${id}/enroll`, {
      method: 'POST',
      body: JSON.stringify({ courseId, startImmediately }),
    });
  }

  async unenrollLearner(id: string) {
    return this.request(`/api/learners/${id}/unenroll`, { method: 'POST' });
  }

  async sendMessage(id: string, data: { type: string; content: string; mediaUrl?: string }) {
    // Backend expects { message } on /api/learners/:id/send-message
    // Keep frontend call signature stable and map content -> message.
    return this.request(`/api/learners/${id}/send-message`, {
      method: 'POST',
      body: JSON.stringify({ message: data.content }),
    });
  }

  async getLearnerProgress(id: string) {
    return this.request(`/api/learners/${id}/progress`);
  }

  async getLearnerMessages(id: string, limit = 20) {
    return this.request(`/api/learners/${id}/messages?limit=${limit}`);
  }

  async resetLearnerFSM(id: string, deleteHistory = false) {
    return this.request(`/api/admin/learners/${id}/reset`, {
      method: 'POST',
      body: JSON.stringify({ deleteHistory }),
    });
  }

  async getLearnerState(id: string) {
    return this.request(`/api/admin/learners/${id}/state`);
  }

  async bulkEnroll(data: { waIds: string[]; courseId: string; sendWelcome?: boolean }) {
    return this.request('/api/learners/bulk-enroll', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Schedules
  async getSchedules() {
    return this.request('/api/schedules');
  }

  async getSchedule(id: string) {
    return this.request(`/api/schedules/${id}`);
  }

  async createSchedule(data: any) {
    return this.request('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSchedule(id: string, data: any) {
    return this.request(`/api/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteSchedule(id: string) {
    return this.request(`/api/schedules/${id}`, { method: 'DELETE' });
  }

  async pauseSchedule(id: string) {
    return this.request(`/api/schedules/${id}/pause`, { method: 'POST' });
  }

  async resumeSchedule(id: string) {
    return this.request(`/api/schedules/${id}/resume`, { method: 'POST' });
  }

  async triggerPush(id: string) {
    return this.request(`/api/schedules/${id}/trigger`, { method: 'POST' });
  }

  async getScheduleLogs(id?: string, params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    if (id) {
      return this.request(`/api/schedules/${id}/logs${query ? `?${query}` : ''}`);
    }
    // Get all logs from all schedules
    return this.request(`/api/schedules/logs${query ? `?${query}` : ''}`);
  }

  // Users
  async getUsers(params?: { page?: number; limit?: number }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request(`/api/users${query ? `?${query}` : ''}`);
  }

  async getUser(id: string) {
    return this.request(`/api/users/${id}`);
  }

  async createUser(data: { email: string; role?: string; name?: string }) {
    return this.request('/api/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateUser(id: string, data: any) {
    return this.request(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(id: string) {
    return this.request(`/api/users/${id}`, { method: 'DELETE' });
  }

  // Analytics & Stats
  async getStats() {
    return this.request<ApiResult<StatsRecord>>('/api/stats');
  }

  async getAnalytics() {
    return this.request('/api/analytics');
  }

  async getChatHistory(phone: string) {
    return this.request<ApiResult<MessageRecord[]>>(`/api/learners/by-phone/${encodeURIComponent(phone)}/messages`);
  }

  // Health & Stats
  async getHealth() {
    return this.request('/health');
  }

  async getDashboard() {
    return this.request('/health/dashboard');
  }

  async testWhatsApp(phoneNumber: string) {
    return this.request('/health/test-whatsapp', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    });
  }

  // Generic request methods for custom endpoints
  async get<T = any>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint);
  }

  async post<T = any>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async put<T = any>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async delete<T = any>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  // FSM Definitions
  async listFsmDefinitions(): Promise<{ success: boolean; data: FSMListItem[] }> {
    return this.request('/api/fsm');
  }

  async getFsmDefinition(id: string): Promise<{ success: boolean; data: FSMDefinition }> {
    return this.request(`/api/fsm/${id}`);
  }

  async createFsmDefinition(data: { name: string; fsmJson?: FSMJson }): Promise<{ success: boolean; data: FSMDefinition }> {
    return this.request('/api/fsm', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateFsmDefinition(id: string, data: { name?: string; fsmJson?: FSMJson }): Promise<{ success: boolean; data: FSMDefinition }> {
    return this.request(`/api/fsm/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteFsmDefinition(id: string): Promise<{ success: boolean }> {
    return this.request(`/api/fsm/${id}`, { method: 'DELETE' });
  }

  async getFSMLearnerPositions(fsmId: string): Promise<{ success: boolean; data: { state_id: string | null; learner_count: number; learners: { id: string; phone: string; name: string }[] }[] }> {
    return this.request(`/api/fsm/${fsmId}/learners`);
  }
}

export const api = new ApiClient();
export const apiClient = api; // Alias for compatibility
export default api;
