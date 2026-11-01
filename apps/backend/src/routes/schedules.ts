/**
 * Schedules API Routes (Simplified)
 * 
 * Basic schedule management
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

// Lazy import
const getDb = () => import('@ekatra/database').then(m => m.db);
const getScheduler = () => import('../services/scheduler.js').then(m => m.getScheduler());

export const schedulesRouter: Router = Router();

/**
 * GET /api/schedules
 * List all schedules
 */
schedulesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { courseId } = req.query;
    
    const schedules = await db.schedules.findAll(courseId as string, req.auth!.organizationId);
    res.json({ success: true, data: schedules });
  } catch (error) {
    logger.error('Error fetching schedules:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedules' });
  }
});

/**
 * GET /api/schedules/logs
 * Get execution logs across all schedules (must be before /:id to avoid param capture)
 */
schedulesRouter.get('/logs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    // schedule_execution_logs table may not exist yet — return empty list gracefully
    try {
      const result = await db.raw(
        `SELECT logs.* FROM schedule_execution_logs logs
         JOIN schedules s ON s.id = logs.schedule_id
         JOIN courses c ON c.id = s.course_id
         WHERE c.organization_id = $1
         ORDER BY logs.executed_at DESC LIMIT $2 OFFSET $3`,
        [req.auth!.organizationId, limit, offset]
      );
      res.json({ success: true, data: result.rows });
    } catch {
      res.json({ success: true, data: [] });
    }
  } catch (error) {
    logger.error('Error fetching schedule logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedule logs' });
  }
});

/**
 * GET /api/schedules/:id
 * Get single schedule
 */
schedulesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const schedule = await db.schedules.findById(id, req.auth!.organizationId);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }
    
    res.json({ success: true, data: schedule });
  } catch (error) {
    logger.error('Error fetching schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedule' });
  }
});

/**
 * POST /api/schedules
 * Create schedule
 */
schedulesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { courseId, name, scheduleType, daysOfWeek, sendTime, timezone, isActive } = req.body;

    if (!courseId || !name) {
      return res.status(400).json({ 
        success: false, 
        error: 'courseId and name are required' 
      });
    }

    const course = await db.courses.findById(courseId, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const schedule = await db.schedules.create({
      courseId,
      name,
      scheduleType,
      daysOfWeek,
      sendTime,
      timezone,
      isActive
    });

    logger.info(`Schedule created: ${schedule.id}`);
    res.json({ success: true, data: schedule });
  } catch (error) {
    logger.error('Error creating schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to create schedule' });
  }
});

/**
 * PUT /api/schedules/:id
 * Update schedule
 */
schedulesRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { name, scheduleType, daysOfWeek, sendTime, timezone, isActive } = req.body;

    const schedule = await db.schedules.update(id, {
      name,
      scheduleType,
      daysOfWeek,
      sendTime,
      timezone,
      isActive
    }, req.auth!.organizationId);

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    logger.info(`Schedule updated: ${id}`);
    res.json({ success: true, data: schedule });
  } catch (error) {
    logger.error('Error updating schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to update schedule' });
  }
});

/**
 * DELETE /api/schedules/:id
 * Delete schedule
 */
schedulesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const schedule = await db.schedules.findById(id, req.auth!.organizationId);
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });
    await db.schedules.delete(id, req.auth!.organizationId);
    logger.info(`Schedule deleted: ${id}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to delete schedule' });
  }
});

/**
 * POST /api/schedules/:id/execute
 * Execute schedule immediately
 */
schedulesRouter.post('/:id/execute', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const scheduler = await getScheduler();
    const { id } = req.params;

    const schedule = await db.schedules.findById(id, req.auth!.organizationId);
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    const result = await scheduler.executeNow(id);
    
    logger.info(`Schedule ${id} executed: ${result.sent} sent, ${result.failed} failed`);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error executing schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to execute schedule' });
  }
});

/**
 * POST /api/schedules/:id/trigger
 * Alias for execute — triggers schedule immediately (matches frontend apiClient.triggerPush)
 */
schedulesRouter.post('/:id/trigger', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const scheduler = await getScheduler();
    const { id } = req.params;

    const schedule = await db.schedules.findById(id, req.auth!.organizationId);
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    const result = await scheduler.executeNow(id);

    logger.info(`Schedule ${id} triggered: ${result.sent} sent, ${result.failed} failed`);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error triggering schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to trigger schedule' });
  }
});

/**
 * POST /api/schedules/:id/pause
 * Pause a schedule (sets isActive = false)
 */
schedulesRouter.post('/:id/pause', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const schedule = await db.schedules.update(id, { isActive: false }, req.auth!.organizationId);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    logger.info(`Schedule paused: ${id}`);
    res.json({ success: true, data: schedule });
  } catch (error) {
    logger.error('Error pausing schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to pause schedule' });
  }
});

/**
 * POST /api/schedules/:id/resume
 * Resume a schedule (sets isActive = true)
 */
schedulesRouter.post('/:id/resume', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const schedule = await db.schedules.update(id, { isActive: true }, req.auth!.organizationId);
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    logger.info(`Schedule resumed: ${id}`);
    res.json({ success: true, data: schedule });
  } catch (error) {
    logger.error('Error resuming schedule:', error);
    res.status(500).json({ success: false, error: 'Failed to resume schedule' });
  }
});

/**
 * GET /api/schedules/:id/logs
 * Get execution logs for a specific schedule
 */
schedulesRouter.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const schedule = await db.schedules.findById(id, req.auth!.organizationId);
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    // schedule_execution_logs table may not exist yet — return empty list gracefully
    try {
      const result = await db.raw(
        `SELECT * FROM schedule_execution_logs WHERE schedule_id = $1 ORDER BY executed_at DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );
      res.json({ success: true, data: result.rows });
    } catch {
      res.json({ success: true, data: [] });
    }
  } catch (error) {
    logger.error('Error fetching schedule logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedule logs' });
  }
});
