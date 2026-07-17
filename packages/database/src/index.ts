/**
 * Database Client for Ekatra
 * 
 * PostgreSQL connection pool and repository pattern
 * Updated to match new schema with organizations, enrollments, lessons
 */

import pg from 'pg';

const { Pool } = pg;

// Database connection
let pool: pg.Pool | null = null;

export function initializeDatabase(config?: {
  connectionString?: string;
}) {
  pool = new Pool({
    connectionString: config?.connectionString || process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // In production (non-local) enforce SSL certificate verification.
    // Set DATABASE_DISABLE_SSL=true only for local Docker development.
    ssl: process.env.DATABASE_DISABLE_SSL === 'true'
      ? false
      : { rejectUnauthorized: true },
  });
  
  // Test connection
  pool.query('SELECT 1').catch(err => {
    console.error('Database connection failed:', err.message);
  });
}

// Check if database is initialized
export function isDatabaseInitialized(): boolean {
  return pool !== null;
}

// Raw query helper
export async function query<T extends pg.QueryResultRow = any>(
  text: string, 
  params?: any[]
): Promise<pg.QueryResult<T>> {
  if (!pool) throw new Error('Database not initialized. Call initializeDatabase() first.');
  return pool.query<T>(text, params);
}

// ============ ORGANIZATIONS ============
const organizationsRepo = {
  async findById(id: string) {
    const result = await query('SELECT * FROM organizations WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findBySlug(slug: string) {
    const result = await query('SELECT * FROM organizations WHERE slug = $1', [slug]);
    return result.rows[0] || null;
  },

  async getDefault() {
    const result = await query('SELECT * FROM organizations ORDER BY created_at LIMIT 1');
    return result.rows[0] || null;
  }
};

// ============ USERS ============
const usersRepo = {
  async findById(id: string) {
    const result = await query('SELECT id, email, name, role, organization_id, created_at FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findByEmail(email: string) {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0] || null;
  },

  async findAll(filters?: { organizationId?: string; page?: number; limit?: number }) {
    const params: any[] = [];
    let idx = 1;
    let where = 'WHERE 1=1';

    if (filters?.organizationId) {
      where += ` AND organization_id = $${idx++}`;
      params.push(filters.organizationId);
    }

    const limit = filters?.limit || 50;
    const offset = ((filters?.page || 1) - 1) * limit;

    const countResult = await query(`SELECT COUNT(*) FROM users ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT id, email, name, role, organization_id, created_at FROM users ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    return { data: result.rows, total };
  },

  async update(id: string, data: { name?: string; role?: string; email?: string }) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
    if (data.role !== undefined) { sets.push(`role = $${idx++}`); params.push(data.role); }
    if (data.email !== undefined) { sets.push(`email = $${idx++}`); params.push(data.email.toLowerCase()); }

    if (sets.length === 0) return null;

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const result = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, email, name, role, organization_id`,
      params
    );
    return result.rows[0] || null;
  },

  async delete(id: string) {
    await query('DELETE FROM users WHERE id = $1', [id]);
  },

  async create(data: { organizationId: string; email: string; passwordHash?: string; name?: string; role?: string }) {
    const result = await query(
      `INSERT INTO users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, organization_id`,
      [data.organizationId, data.email, data.passwordHash, data.name, data.role || 'admin']
    );
    return result.rows[0];
  }
};

// ============ COURSES ============
const coursesRepo = {
  async findAll(filters?: {
    organizationId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    let sql = 'SELECT * FROM courses WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (filters?.organizationId) {
      sql += ` AND organization_id = $${idx++}`;
      params.push(filters.organizationId);
    }
    if (filters?.status) {
      sql += ` AND status = $${idx++}`;
      params.push(filters.status);
    }
    if (filters?.search) {
      sql += ` AND (title ILIKE $${idx} OR description ILIKE $${idx++})`;
      params.push(`%${filters.search}%`);
    }

    // Count
    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    // Paginate
    const limit = filters?.limit || 20;
    const offset = ((filters?.page || 1) - 1) * limit;
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    
    return {
      data: result.rows,
      pagination: { total, page: filters?.page || 1, limit, pages: Math.ceil(total / limit) }
    };
  },

  async findById(id: string) {
    const result = await query('SELECT * FROM courses WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findPublished(organizationId?: string) {
    let sql = `SELECT * FROM courses WHERE status = 'published'`;
    const params: any[] = [];
    
    if (organizationId) {
      sql += ' AND organization_id = $1';
      params.push(organizationId);
    }
    sql += ' ORDER BY created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  },

  async create(data: {
    organizationId: string;
    title: string;
    description?: string;
    category?: string;
    status?: string;
    settings?: any;
    createdBy?: string;
  }) {
    const result = await query(
      `INSERT INTO courses (organization_id, title, description, category, status, settings, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [data.organizationId, data.title, data.description, data.category, 
       data.status || 'draft', data.settings || {}, data.createdBy]
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    title: string;
    description: string;
    category: string;
    status: string;
    settings: any;
    fsm_definition_id: string | null;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE courses SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async delete(id: string) {
    await query('DELETE FROM courses WHERE id = $1', [id]);
  },

  async getStats(organizationId?: string) {
    let sql = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'published') as published,
        COUNT(*) FILTER (WHERE status = 'draft') as draft
      FROM courses
    `;
    const params: any[] = [];
    if (organizationId) {
      sql += ' WHERE organization_id = $1';
      params.push(organizationId);
    }
    const result = await query(sql, params);
    return result.rows[0];
  },

  async getPerformanceStats() {
    const result = await query(`
      SELECT
        c.id,
        c.title,
        COUNT(e.id)::int                                                           AS enrolled,
        ROUND(
          100.0 * COUNT(e.id) FILTER (WHERE e.status = 'completed') /
          NULLIF(COUNT(e.id), 0)
        )::int                                                                     AS completion_pct
      FROM courses c
      LEFT JOIN enrollments e ON e.course_id = c.id
      GROUP BY c.id, c.title
      ORDER BY enrolled DESC
    `);
    return result.rows;
  }
};

// ============ LESSONS ============
const lessonsRepo = {
  async findByCourse(courseId: string) {
    const result = await query(
      `SELECT * FROM lessons WHERE course_id = $1 ORDER BY sequence_order`,
      [courseId]
    );
    return result.rows;
  },

  async findById(id: string) {
    const result = await query('SELECT * FROM lessons WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findBySequence(courseId: string, sequenceOrder: number) {
    const result = await query(
      `SELECT * FROM lessons WHERE course_id = $1 AND sequence_order = $2`,
      [courseId, sequenceOrder]
    );
    return result.rows[0] || null;
  },

  async create(data: {
    courseId: string;
    title: string;
    content?: string;
    contentType?: string;
    mediaUrl?: string;
    sequenceOrder: number;
    durationMinutes?: number;
    dayNumber?: number;
    metadata?: any;
  }) {
    const result = await query(
      `INSERT INTO lessons (course_id, title, content, content_type, media_url, sequence_order, duration_minutes, day_number, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [data.courseId, data.title, data.content, data.contentType || 'text',
       data.mediaUrl, data.sequenceOrder, data.durationMinutes || 5,
       data.dayNumber ?? 1, data.metadata || {}]
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    title: string;
    content: string;
    contentType: string;
    mediaUrl: string;
    sequenceOrder: number;
    durationMinutes: number;
    dayNumber: number;
    metadata: any;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      content: 'content',
      contentType: 'content_type',
      mediaUrl: 'media_url',
      sequenceOrder: 'sequence_order',
      durationMinutes: 'duration_minutes',
      dayNumber: 'day_number',
      metadata: 'metadata'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE lessons SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async delete(id: string) {
    await query('DELETE FROM lessons WHERE id = $1', [id]);
  },

  async countByCourse(courseId: string) {
    const result = await query(
      'SELECT COUNT(*) FROM lessons WHERE course_id = $1',
      [courseId]
    );
    return parseInt(result.rows[0].count);
  }
};

// ============ LEARNERS ============
const learnersRepo = {
  async findAll(filters?: {
    organizationId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    let sql = 'SELECT * FROM learners WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (filters?.organizationId) {
      sql += ` AND organization_id = $${idx++}`;
      params.push(filters.organizationId);
    }
    if (filters?.status) {
      sql += ` AND status = $${idx++}`;
      params.push(filters.status);
    }
    if (filters?.search) {
      sql += ` AND (name ILIKE $${idx} OR phone ILIKE $${idx} OR email ILIKE $${idx++})`;
      params.push(`%${filters.search}%`);
    }

    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count);

    const limit = filters?.limit || 50;
    const offset = ((filters?.page || 1) - 1) * limit;
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return {
      data: result.rows,
      pagination: { total, page: filters?.page || 1, limit, pages: Math.ceil(total / limit) }
    };
  },

  async findById(id: string) {
    const result = await query('SELECT * FROM learners WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findByPhone(phone: string, organizationId?: string) {
    const formatted = phone.replace(/\D/g, '');
    let sql = 'SELECT * FROM learners WHERE (phone = $1 OR phone = $2)';
    const params: any[] = [phone, formatted];
    
    if (organizationId) {
      sql += ' AND organization_id = $3';
      params.push(organizationId);
    }
    
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async findByWhatsAppId(whatsappId: string) {
    const result = await query(
      'SELECT * FROM learners WHERE whatsapp_id = $1',
      [whatsappId]
    );
    return result.rows[0] || null;
  },

  async create(data: {
    organizationId: string;
    phone: string;
    name?: string;
    email?: string;
    whatsappId?: string;
    timezone?: string;
    language?: string;
    metadata?: any;
  }) {
    const result = await query(
      `INSERT INTO learners (organization_id, phone, name, email, whatsapp_id, timezone, language, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [data.organizationId, data.phone, data.name, data.email, 
       data.whatsappId, data.timezone || 'UTC', data.language || 'en', data.metadata || {}]
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    name: string;
    email: string;
    whatsappId: string;
    timezone: string;
    language: string;
    status: string;
    metadata: any;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      email: 'email',
      whatsappId: 'whatsapp_id',
      timezone: 'timezone',
      language: 'language',
      status: 'status',
      metadata: 'metadata'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE learners SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  /**
   * Atomically update the FSM context on a learner's metadata using optimistic locking.
   *
   * The UPDATE only fires if the stored `metadata->>'fsm'->>'version'` equals
   * `expectedVersion`. Returns the updated row on success, or null if the version
   * was stale (i.e. a concurrent handler already advanced state).
   */
  async updateFSM(id: string, fsm: { state: string; data: unknown; version: number }, expectedVersion: number) {
    const result = await query(
      `UPDATE learners
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{fsm}',
                $1::jsonb
              ),
              updated_at = NOW()
        WHERE id = $2
          AND (
                metadata IS NULL
                OR metadata->'fsm' IS NULL
                OR (metadata->'fsm'->>'version')::int = $3
              )
        RETURNING *`,
      [JSON.stringify(fsm), id, expectedVersion]
    );
    return result.rows[0] || null;
  },

  async getStats(organizationId?: string) {
    let sql = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'paused') as paused
      FROM learners
    `;
    const params: any[] = [];
    if (organizationId) {
      sql += ' WHERE organization_id = $1';
      params.push(organizationId);
    }
    const result = await query(sql, params);
    return result.rows[0];
  },

  async getDailyRegistrations(days = 30) {
    const result = await query(`
      SELECT
        gs.day::date AS label,
        COUNT(l.id)::int AS registrations
      FROM generate_series(
        NOW() - ($1 || ' days')::interval,
        NOW(),
        '1 day'::interval
      ) AS gs(day)
      LEFT JOIN learners l ON l.created_at::date = gs.day::date
      GROUP BY gs.day
      ORDER BY gs.day
    `, [days]);
    return result.rows;
  }
};

// ============ ENROLLMENTS ============
const enrollmentsRepo = {
  async findByLearner(learnerId: string) {
    const result = await query(
      `SELECT e.*, c.title as course_title, c.description as course_description
       FROM enrollments e
       JOIN courses c ON e.course_id = c.id
       WHERE e.learner_id = $1
       ORDER BY e.created_at DESC`,
      [learnerId]
    );
    return result.rows;
  },

  async findByCourse(courseId: string, status?: string) {
    let sql = `
      SELECT e.*, l.phone, l.name as learner_name, l.email as learner_email
      FROM enrollments e
      JOIN learners l ON e.learner_id = l.id
      WHERE e.course_id = $1
    `;
    const params: any[] = [courseId];
    
    if (status) {
      sql += ' AND e.status = $2';
      params.push(status);
    }
    sql += ' ORDER BY e.created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  },

  async findById(id: string) {
    const result = await query(
      'SELECT * FROM enrollments WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  async find(learnerId: string, courseId: string) {
    const result = await query(
      'SELECT * FROM enrollments WHERE learner_id = $1 AND course_id = $2 ORDER BY created_at DESC',
      [learnerId, courseId]
    );
    return result.rows[0] || null;
  },

  async findActiveByLearner(learnerId: string) {
    const result = await query(
      `SELECT * FROM enrollments
       WHERE learner_id = $1 AND status IN ('enrolled', 'in_progress')
       ORDER BY created_at DESC LIMIT 1`,
      [learnerId]
    );
    return result.rows[0] || null;
  },

  async create(data: {
    learnerId: string;
    courseId: string;
    status?: string;
    fsmDefinitionId?: string | null;
  }) {
    const result = await query(
      `INSERT INTO enrollments (learner_id, course_id, status, fsm_definition_id, started_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [data.learnerId, data.courseId, data.status || 'enrolled', data.fsmDefinitionId ?? null]
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    status: string;
    progress: number;
    currentLessonId: string;
    completedAt: Date;
    fsmDefinitionId: string | null;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      status: 'status',
      progress: 'progress',
      currentLessonId: 'current_lesson_id',
      completedAt: 'completed_at',
      fsmDefinitionId: 'fsm_definition_id'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE enrollments SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async getActiveForCourse(courseId: string) {
    const result = await query(
      `SELECT e.*, l.phone, l.name as learner_name
       FROM enrollments e
       JOIN learners l ON e.learner_id = l.id
       WHERE e.course_id = $1 AND e.status IN ('enrolled', 'in_progress')`,
      [courseId]
    );
    return result.rows;
  },

  async getStats(courseId?: string) {
    let sql = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'enrolled') as enrolled,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'dropped') as dropped
      FROM enrollments
    `;
    const params: any[] = [];
    if (courseId) {
      sql += ' WHERE course_id = $1';
      params.push(courseId);
    }
    const result2 = await query(sql, params);
    return result2.rows[0];
  },

  async getCompletionBreakdown() {
    const result = await query(`
      SELECT status, COUNT(*)::int AS count
      FROM enrollments
      GROUP BY status
    `);
    return result.rows;
  }
};

// ============ SCHEDULES ============
const schedulesRepo = {
  async findAll(courseId?: string) {
    let sql = 'SELECT s.*, c.title as course_title FROM schedules s JOIN courses c ON s.course_id = c.id';
    const params: any[] = [];
    
    if (courseId) {
      sql += ' WHERE s.course_id = $1';
      params.push(courseId);
    }
    sql += ' ORDER BY s.created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  },

  async findById(id: string) {
    const result = await query(
      `SELECT s.*, c.title as course_title 
       FROM schedules s 
       JOIN courses c ON s.course_id = c.id 
       WHERE s.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findActive() {
    const result = await query(
      `SELECT s.*, c.title as course_title 
       FROM schedules s 
       JOIN courses c ON s.course_id = c.id 
       WHERE s.is_active = true`
    );
    return result.rows;
  },

  async create(data: {
    courseId: string;
    name: string;
    scheduleType?: string;
    daysOfWeek?: number[];
    sendTime?: string;
    timezone?: string;
    isActive?: boolean;
  }) {
    const result = await query(
      `INSERT INTO schedules (course_id, name, schedule_type, days_of_week, send_time, timezone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [data.courseId, data.name, data.scheduleType || 'daily',
       data.daysOfWeek || [1,2,3,4,5], data.sendTime || '09:00',
       data.timezone || 'UTC', data.isActive ?? true]
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    name: string;
    scheduleType: string;
    daysOfWeek: number[];
    sendTime: string;
    timezone: string;
    isActive: boolean;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      scheduleType: 'schedule_type',
      daysOfWeek: 'days_of_week',
      sendTime: 'send_time',
      timezone: 'timezone',
      isActive: 'is_active'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE schedules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async delete(id: string) {
    await query('DELETE FROM schedules WHERE id = $1', [id]);
  }
};

// ============ MESSAGE LOG ============
const messageLogRepo = {
  async findByLearner(learnerId: string, limit: number = 50) {
    const result = await query(
      `SELECT * FROM message_log WHERE learner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [learnerId, limit]
    );
    return result.rows;
  },

  async create(data: {
    learnerId?: string;
    direction: 'inbound' | 'outbound';
    messageType?: string;
    content?: string;
    mediaUrl?: string;
    whatsappMessageId?: string;
    status?: string;
    metadata?: any;
    inReplyTo?: string;
    responseTimeMs?: number;
  }) {
    const result = await query(
      `INSERT INTO message_log (learner_id, direction, message_type, content, media_url, whatsapp_message_id, status, metadata, in_reply_to, response_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [data.learnerId, data.direction, data.messageType || 'text',
       data.content, data.mediaUrl, data.whatsappMessageId,
       data.status || 'sent', data.metadata || {}, data.inReplyTo || null, data.responseTimeMs || null]
    );
    return result.rows[0];
  },

  async getStats() {
    const result = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE direction = 'inbound') as inbound,
        COUNT(*) FILTER (WHERE direction = 'outbound') as outbound,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') as today
      FROM message_log
    `);
    return result.rows[0];
  },

  async findByWhatsAppMessageId(whatsappMessageId: string) {
    const result = await query(
      `SELECT * FROM message_log WHERE whatsapp_message_id = $1 LIMIT 1`,
      [whatsappMessageId]
    );
    return result.rows[0] || null;
  },

  async findMostRecentOutbound(learnerId: string) {
    const result = await query(
      `SELECT * FROM message_log
       WHERE learner_id = $1 AND direction = 'outbound'
       ORDER BY created_at DESC LIMIT 1`,
      [learnerId]
    );
    return result.rows[0] || null;
  },

  async updateStatus(whatsappMessageId: string, status: string, timestamp?: Date, extraMetadata?: Record<string, any>) {
    const ts = timestamp ? timestamp.toISOString() : new Date().toISOString();
    const statusKey = `${status}_at`;
    // Merge timestamp and any extra fields (error_code, channel_error) into metadata
    const metadataPatch: Record<string, any> = { [statusKey]: ts };
    if (extraMetadata) {
      Object.assign(metadataPatch, extraMetadata);
    }
    const result = await query(
      `UPDATE message_log
       SET status = $2,
           metadata = metadata || $3::jsonb
       WHERE whatsapp_message_id = $1
       RETURNING *`,
      [whatsappMessageId, status, JSON.stringify(metadataPatch)]
    );
    return result.rows[0] || null;
  },

  async getDailyVolume(days = 30) {
    const result = await query(`
      SELECT
        gs.day::date AS label,
        COUNT(ml.id) FILTER (WHERE ml.direction = 'outbound')::int AS outbound,
        COUNT(ml.id) FILTER (WHERE ml.direction = 'inbound')::int  AS inbound
      FROM generate_series(
        NOW() - ($1 || ' days')::interval,
        NOW(),
        '1 day'::interval
      ) AS gs(day)
      LEFT JOIN message_log ml ON ml.created_at::date = gs.day::date
      GROUP BY gs.day
      ORDER BY gs.day
    `, [days]);
    return result.rows;
  },

  async getDeliveryStats() {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE direction = 'outbound')::int                   AS sent,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read')::int      AS read,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed')::int    AS failed
      FROM message_log
    `);
    return result.rows[0];
  }
};

// ============ FAILED MESSAGES (Dead-Letter Queue) ============
const failedMessagesRepo = {
  /**
   * Persist a message that exhausted all retry attempts.
   * Allows ops to inspect, replay, or dismiss failures without silent data loss.
   */
  async log(data: {
    learnerId?: string;
    phone?: string;
    messageType: string;
    payload: Record<string, unknown>;
    errorMessage?: string;
    attempts: number;
  }) {
    const result = await query(
      `INSERT INTO failed_messages
         (learner_id, phone, message_type, payload, error_message, attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.learnerId || null,
        data.phone || null,
        data.messageType,
        JSON.stringify(data.payload),
        data.errorMessage || null,
        data.attempts,
      ]
    );
    return result.rows[0];
  },

  async findUnresolved(limit = 50) {
    const result = await query(
      `SELECT * FROM failed_messages WHERE resolved = FALSE ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  async resolve(id: string, resolvedBy: string) {
    const result = await query(
      `UPDATE failed_messages SET resolved = TRUE, resolved_at = NOW(), resolved_by = $1 WHERE id = $2 RETURNING *`,
      [resolvedBy, id]
    );
    return result.rows[0] || null;
  },
};

// ============ LESSON PROGRESS ============
const lessonProgressRepo = {
  async find(enrollmentId: string, lessonId: string) {
    const result = await query(
      'SELECT * FROM lesson_progress WHERE enrollment_id = $1 AND lesson_id = $2',
      [enrollmentId, lessonId]
    );
    return result.rows[0] || null;
  },

  async findByEnrollment(enrollmentId: string) {
    const result = await query(
      `SELECT lp.*, l.title as lesson_title, l.sequence_order
       FROM lesson_progress lp
       JOIN lessons l ON lp.lesson_id = l.id
       WHERE lp.enrollment_id = $1
       ORDER BY l.sequence_order`,
      [enrollmentId]
    );
    return result.rows;
  },

  async create(data: {
    enrollmentId: string;
    lessonId: string;
    status?: string;
  }) {
    const result = await query(
      `INSERT INTO lesson_progress (enrollment_id, lesson_id, status, started_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [data.enrollmentId, data.lessonId, data.status || 'started']
    );
    return result.rows[0];
  },

  async update(id: string, data: Partial<{
    status: string;
    completedAt: Date;
    score: number;
    attempts: number;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      status: 'status',
      completedAt: 'completed_at',
      score: 'score',
      attempts: 'attempts'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE lesson_progress SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }
};

// ============ QUIZ ============
const quizRepo = {
  async findByLesson(lessonId: string) {
    const result = await query(
      'SELECT * FROM quiz_questions WHERE lesson_id = $1 ORDER BY sequence_order',
      [lessonId]
    );
    return result.rows;
  },

  async createQuestion(data: {
    lessonId: string;
    question: string;
    questionType?: string;
    options?: any;
    correctAnswer?: string;
    explanation?: string;
    sequenceOrder?: number;
  }) {
    const result = await query(
      `INSERT INTO quiz_questions (lesson_id, question, question_type, options, correct_answer, explanation, sequence_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [data.lessonId, data.question, data.questionType || 'multiple_choice',
       data.options, data.correctAnswer, data.explanation, data.sequenceOrder || 0]
    );
    return result.rows[0];
  },

  async saveResponse(data: {
    learnerId: string;
    questionId: string;
    answer: string;
    isCorrect: boolean;
  }) {
    const result = await query(
      `INSERT INTO quiz_responses (learner_id, question_id, answer, is_correct)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.learnerId, data.questionId, data.answer, data.isCorrect]
    );
    return result.rows[0];
  }
};

// ============ DOCUMENT EMBEDDINGS ============
const embeddingsRepo = {
  async create(data: {
    courseId: string;
    lessonId?: string;
    content: string;
    embedding: number[];
    metadata?: any;
  }) {
    const result = await query(
      `INSERT INTO document_embeddings (course_id, lesson_id, content, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [data.courseId, data.lessonId, data.content, JSON.stringify(data.embedding), data.metadata || {}]
    );
    return result.rows[0];
  },

  async search(courseId: string, embedding: number[], limit: number = 5) {
    // Vector similarity search using pgvector
    const result = await query(
      `SELECT id, content, metadata, 
              1 - (embedding <=> $1::vector) as similarity
       FROM document_embeddings
       WHERE course_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(embedding), courseId, limit]
    );
    return result.rows;
  }
};

// ============ FLASHCARDS ============
const flashcardsRepo = {
  async findByLesson(lessonId: string) {
    const result = await query(
      'SELECT * FROM flashcards WHERE lesson_id = $1 ORDER BY sequence_order',
      [lessonId]
    );
    return result.rows;
  },

  async findByLessons(lessonIds: string[]) {
    if (lessonIds.length === 0) return [];
    const placeholders = lessonIds.map((_, i) => `$${i + 1}`).join(', ');
    const result = await query(
      `SELECT * FROM flashcards WHERE lesson_id IN (${placeholders}) ORDER BY lesson_id, sequence_order`,
      lessonIds
    );
    return result.rows;
  },

  async create(data: {
    lessonId: string;
    front: string;
    back: string;
    sequenceOrder?: number;
  }) {
    const result = await query(
      `INSERT INTO flashcards (lesson_id, front, back, sequence_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.lessonId, data.front, data.back, data.sequenceOrder ?? 0]
    );
    return result.rows[0];
  },

  async countByLesson(lessonId: string) {
    const result = await query(
      'SELECT COUNT(*) FROM flashcards WHERE lesson_id = $1',
      [lessonId]
    );
    return parseInt(result.rows[0].count);
  }
};

// ============ FLASHCARD PROGRESS ============
const flashcardProgressRepo = {
  async find(learnerId: string, flashcardId: string) {
    const result = await query(
      'SELECT * FROM flashcard_progress WHERE learner_id = $1 AND flashcard_id = $2',
      [learnerId, flashcardId]
    );
    return result.rows[0] || null;
  },

  async findDueForLearner(learnerId: string) {
    // Returns flashcards with their progress, ordered by due_date ascending
    const result = await query(
      `SELECT fp.*, f.front, f.back, f.lesson_id
       FROM flashcard_progress fp
       JOIN flashcards f ON fp.flashcard_id = f.id
       WHERE fp.learner_id = $1
         AND fp.due_date <= NOW()
       ORDER BY fp.due_date ASC`,
      [learnerId]
    );
    return result.rows;
  },

  async countDueForLearner(learnerId: string) {
    const result = await query(
      `SELECT COUNT(*) FROM flashcard_progress
       WHERE learner_id = $1 AND due_date <= NOW()`,
      [learnerId]
    );
    return parseInt(result.rows[0].count);
  },

  async upsert(learnerId: string, flashcardId: string, data?: Partial<{
    dueDate: Date;
    intervalDays: number;
    easeFactor: number;
    reps: number;
    lapses: number;
    lastReviewAt: Date;
  }>) {
    // Insert new progress record or update existing on conflict
    const result = await query(
      `INSERT INTO flashcard_progress (learner_id, flashcard_id, due_date, interval_days, ease_factor, reps, lapses, last_review_at)
       VALUES ($1, $2, COALESCE($3, NOW()), $4, $5, $6, $7, $8)
       ON CONFLICT (learner_id, flashcard_id) DO UPDATE SET
         due_date       = COALESCE(EXCLUDED.due_date, flashcard_progress.due_date),
         interval_days  = COALESCE(EXCLUDED.interval_days, flashcard_progress.interval_days),
         ease_factor    = COALESCE(EXCLUDED.ease_factor, flashcard_progress.ease_factor),
         reps           = COALESCE(EXCLUDED.reps, flashcard_progress.reps),
         lapses         = COALESCE(EXCLUDED.lapses, flashcard_progress.lapses),
         last_review_at = COALESCE(EXCLUDED.last_review_at, flashcard_progress.last_review_at),
         updated_at     = NOW()
       RETURNING *`,
      [
        learnerId,
        flashcardId,
        data?.dueDate ?? null,
        data?.intervalDays ?? 1,
        data?.easeFactor ?? 2.5,
        data?.reps ?? 0,
        data?.lapses ?? 0,
        data?.lastReviewAt ?? null,
      ]
    );
    return result.rows[0];
  },

  async updateById(id: string, data: Partial<{
    dueDate: Date;
    intervalDays: number;
    easeFactor: number;
    reps: number;
    lapses: number;
    lastReviewAt: Date;
  }>) {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      dueDate: 'due_date',
      intervalDays: 'interval_days',
      easeFactor: 'ease_factor',
      reps: 'reps',
      lapses: 'lapses',
      lastReviewAt: 'last_review_at',
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        sets.push(`${fieldMap[key]} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return null;

    params.push(id);
    const result = await query(
      `UPDATE flashcard_progress SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  // Enqueue all flashcards from a course as new flashcard_progress rows for a learner
  async enqueueForLearner(learnerId: string, lessonIds: string[]) {
    if (lessonIds.length === 0) return;
    const flashcards = await flashcardsRepo.findByLessons(lessonIds);
    for (const fc of flashcards) {
      // upsert with defaults — won't overwrite existing progress
      await query(
        `INSERT INTO flashcard_progress (learner_id, flashcard_id)
         VALUES ($1, $2)
         ON CONFLICT (learner_id, flashcard_id) DO NOTHING`,
        [learnerId, fc.id]
      );
    }
    return flashcards.length;
  }
};

// ============ CONTENT API CACHE REPO ============
const contentApiCacheRepo = {
  async findAll(): Promise<Array<{ cache_key: string; content_sid: string }>> {
    const result = await query<{ cache_key: string; content_sid: string }>(
      'SELECT cache_key, content_sid FROM content_api_cache'
    );
    return result.rows;
  },
  async upsert(cacheKey: string, contentSid: string): Promise<void> {
    await query(
      `INSERT INTO content_api_cache (cache_key, content_sid)
       VALUES ($1, $2)
       ON CONFLICT (cache_key) DO UPDATE SET content_sid = EXCLUDED.content_sid`,
      [cacheKey, contentSid]
    );
  },
};

// ============ FSM DEFINITIONS REPO ============
const fsmDefinitionsRepo = {
  async findAll(organizationId: string): Promise<{ id: string; name: string; version: number; created_at: string; updated_at: string }[]> {
    const result = await query(
      `SELECT id, name, version, created_at, updated_at
       FROM fsm_definitions
       WHERE organization_id = $1
       ORDER BY updated_at DESC`,
      [organizationId]
    );
    return result.rows;
  },

  async findById(id: string): Promise<{ id: string; organization_id: string; name: string; version: number; fsm_json: object; created_by: string | null; created_at: string; updated_at: string } | null> {
    const result = await query(
      `SELECT id, organization_id, name, version, fsm_json, created_by, created_at, updated_at
       FROM fsm_definitions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  },

  async create(data: { organizationId: string; name: string; fsmJson: object; createdBy?: string }): Promise<{ id: string; organization_id: string; name: string; version: number; fsm_json: object }> {
    const result = await query(
      `INSERT INTO fsm_definitions (organization_id, name, fsm_json, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, name, version, fsm_json`,
      [data.organizationId, data.name, JSON.stringify(data.fsmJson), data.createdBy ?? null]
    );
    return result.rows[0];
  },

  async update(id: string, data: { name?: string; fsmJson?: object }): Promise<{ id: string; name: string; version: number; fsm_json: object; updated_at: string } | null> {
    const fields: string[] = ['updated_at = NOW()', 'version = version + 1'];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
    if (data.fsmJson !== undefined) { fields.push(`fsm_json = $${idx++}`); values.push(JSON.stringify(data.fsmJson)); }

    values.push(id);
    const result = await query(
      `UPDATE fsm_definitions SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, name, version, fsm_json, updated_at`,
      values
    );
    return result.rows[0] ?? null;
  },

  async delete(id: string): Promise<void> {
    await query('DELETE FROM fsm_definitions WHERE id = $1', [id]);
  },
};

// ============ EXPORT ============
export const db = {
  raw: query,
  organizations: organizationsRepo,
  users: usersRepo,
  courses: coursesRepo,
  lessons: lessonsRepo,
  learners: learnersRepo,
  enrollments: enrollmentsRepo,
  schedules: schedulesRepo,
  messageLog: messageLogRepo,
  lessonProgress: lessonProgressRepo,
  quiz: quizRepo,
  embeddings: embeddingsRepo,
  flashcards: flashcardsRepo,
  flashcardProgress: flashcardProgressRepo,
  contentApiCache: contentApiCacheRepo,
  failedMessages: failedMessagesRepo,
  fsmDefinitions: fsmDefinitionsRepo,
};

export default db;
