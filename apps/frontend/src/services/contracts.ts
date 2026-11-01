export interface ApiResult<T> { success: boolean; data: T; }
export interface LessonRecord {
  id: string; title: string; content?: string; day_number?: number;
  media_url?: string; sequence_order?: number;
}
export interface CourseRecord {
  settings?: { instructor?: string; language?: string; price?: number };
  id: string; title: string; description?: string; category?: string;
  language?: string; instructor?: string; price?: number;
  status: 'draft' | 'published' | 'archived'; created_at?: string;
  enrolled_count?: number; completion_rate?: number;
  lessons?: LessonRecord[]; fsm_definition_id?: string | null;
  source?: 'authored' | 'ai_generated';
}
export interface StatsRecord {
  totalUsers: number; activeCourses: number; completionRate: number; messagesSent: number;
}
export interface MessageRecord {
  id: string; direction: 'inbound' | 'outbound'; content?: string;
  message_type: string; status: string; created_at: string;
}
