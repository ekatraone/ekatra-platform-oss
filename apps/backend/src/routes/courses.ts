/**
 * Courses API Routes
 * 
 * CRUD for courses and lessons
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { requireRole } from '../middleware/auth.js';

// Lazy import to avoid circular dependencies
const getDb = () => import('@ekatra/database').then(m => m.db);

export const coursesRouter: Router = Router();

/**
 * GET /api/courses
 * List all courses with optional filters
 */
coursesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { status, search, page = 1, limit = 20 } = req.query;
    
    const courses = await db.courses.findAll({
      organizationId: req.auth!.organizationId,
      status: status as string,
      search: search as string,
      page: Math.max(1, Number(page) || 1),
      // Clamp: the value goes straight into SQL LIMIT; clients page for more (max 100 rows/page).
      limit: Math.min(100, Math.max(1, Number(limit) || 20))
    });

    res.json({
      success: true,
      data: courses.data,
      pagination: courses.pagination
    });
  } catch (error) {
    logger.error('Error fetching courses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch courses' });
  }
});

/**
 * GET /api/courses/:id
 * Get single course with all lessons
 */
coursesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const course = await db.courses.findById(id, req.auth!.organizationId);
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    // Get all lessons for this course
    const lessons = await db.lessons.findByCourse(id);

    res.json({
      success: true,
      data: {
        ...course,
        lessons
      }
    });
  } catch (error) {
    logger.error('Error fetching course:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course' });
  }
});

/**
 * POST /api/courses
 * Create new course
 */
coursesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { title, description, category, status } = req.body;

    if (!title) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title is required' 
      });
    }

    const course = await db.courses.create({
      organizationId: req.auth!.organizationId,
      title,
      description,
      category,
      status: status || 'draft',
      createdBy: req.auth!.userId,
    });

    logger.info(`Course created: ${course.id}`);
    res.json({ success: true, data: course });
  } catch (error) {
    logger.error('Error creating course:', error);
    res.status(500).json({ success: false, error: 'Failed to create course' });
  }
});

/**
 * POST /api/courses/lessons/:lessonId/send-media
 * Generate AI media for a lesson (image / narration / video, per available
 * capabilities) and send it with the lesson text to a learner address.
 * Body: { to } — e.g. "tg:<chat_id>" (Telegram) — media buffers are Telegram-only today.
 */
coursesRouter.post('/lessons/:lessonId/send-media', requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Missing "to" (learner address)' });
    const lesson = await db.lessons.findById(req.params.lessonId);
    const course = lesson ? await db.courses.findById(lesson.course_id, req.auth!.organizationId) : null;
    if (!lesson || !course) return res.status(404).json({ success: false, error: 'Lesson not found' });
    const { sendLessonWithMedia } = await import('../services/lessonMedia.js');
    const result = await sendLessonWithMedia(req.params.lessonId, to);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('Error sending lesson media:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send lesson media' });
  }
});

/**
 * POST /api/courses/generate
 * AI-generate a course from a topic.
 * Body: { topic, goal?, language?, style?, numDays?, numModules? }
 */
coursesRouter.post('/generate', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { topic, goal, language, style, numDays, numModules } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'topic is required (min 2 characters)' });
    }

    const organizationId = req.auth!.organizationId;

    const { courseGenerator } = await import('../services/courseGenerator.js');

    logger.info(`🎓 API: generating course "${topic}" for org ${organizationId}`);

    const course = await courseGenerator.generate({
      topic: topic.trim(),
      goal,
      language: language || 'en',
      style: style || 'conversational',
      numDays: numDays ? Number(numDays) : 3,
      numModules: numModules ? Number(numModules) : 3,
      organizationId,
    });

    const lessonCount = await db.lessons.countByCourse(course.id);

    res.status(201).json({
      success: true,
      data: {
        courseId: course.id,
        title: course.title,
        description: course.description,
        lessonCount,
        status: course.status,
      },
    });
  } catch (error) {
    logger.error('Error generating course:', error);
    res.status(500).json({ success: false, error: 'Course generation failed' });
  }
});

/**
 * PUT /api/courses/:id
 * Update course
 */
coursesRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, description, category, status, settings, fsm_definition_id } = req.body;

    if (fsm_definition_id) {
      const definition = await db.fsmDefinitions.findById(fsm_definition_id);
      if (!definition || definition.organization_id !== req.auth!.organizationId) {
        return res.status(404).json({ success: false, error: 'FSM definition not found' });
      }
    }

    const course = await db.courses.update(id, {
      title,
      description,
      category,
      status,
      settings,
      fsm_definition_id
    }, req.auth!.organizationId);

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    logger.info(`Course updated: ${id}`);
    res.json({ success: true, data: course });
  } catch (error) {
    logger.error('Error updating course:', error);
    res.status(500).json({ success: false, error: 'Failed to update course' });
  }
});

/**
 * DELETE /api/courses/:id
 * Delete course
 */
coursesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const course = await db.courses.findById(id, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });
    await db.courses.delete(id, req.auth!.organizationId);
    logger.info(`Course deleted: ${id}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting course:', error);
    res.status(500).json({ success: false, error: 'Failed to delete course' });
  }
});

/**
 * POST /api/courses/:id/publish
 * Publish course
 */
coursesRouter.post('/:id/publish', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const course = await db.courses.update(id, { status: 'published' }, req.auth!.organizationId);
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    logger.info(`Course published: ${id}`);
    res.json({ success: true, data: course });
  } catch (error) {
    logger.error('Error publishing course:', error);
    res.status(500).json({ success: false, error: 'Failed to publish course' });
  }
});

/**
 * POST /api/courses/:id/unpublish
 * Unpublish course
 */
coursesRouter.post('/:id/unpublish', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const course = await db.courses.update(id, { status: 'draft' }, req.auth!.organizationId);
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    logger.info(`Course unpublished: ${id}`);
    res.json({ success: true, data: course });
  } catch (error) {
    logger.error('Error unpublishing course:', error);
    res.status(500).json({ success: false, error: 'Failed to unpublish course' });
  }
});

/**
 * POST /api/courses/:id/duplicate
 * Duplicate a course
 */
coursesRouter.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { newTitle } = req.body;

    const originalCourse = await db.courses.findById(id, req.auth!.organizationId);
    if (!originalCourse) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    // Create new course
    const newCourse = await db.courses.create({
      organizationId: originalCourse.organization_id,
      title: newTitle || `${originalCourse.title} (Copy)`,
      description: originalCourse.description,
      category: originalCourse.category,
      status: 'draft',
      settings: originalCourse.settings
    });

    // Duplicate lessons
    const lessons = await db.lessons.findByCourse(id);
    for (const lesson of lessons) {
      await db.lessons.create({
        courseId: newCourse.id,
        title: lesson.title,
        content: lesson.content,
        contentType: lesson.content_type,
        mediaUrl: lesson.media_url,
        sequenceOrder: lesson.sequence_order,
        durationMinutes: lesson.duration_minutes,
        metadata: lesson.metadata
      });
    }

    logger.info(`Course duplicated: ${id} -> ${newCourse.id}`);
    res.json({ success: true, data: newCourse });
  } catch (error) {
    logger.error('Error duplicating course:', error);
    res.status(500).json({ success: false, error: 'Failed to duplicate course' });
  }
});

/**
 * GET /api/courses/:id/lessons
 * Get all lessons for a course
 */
coursesRouter.get('/:id/lessons', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const course = await db.courses.findById(id, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const lessons = await db.lessons.findByCourse(id);
    res.json({ success: true, data: lessons });
  } catch (error) {
    logger.error('Error fetching lessons:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lessons' });
  }
});

/**
 * POST /api/courses/:id/lessons
 * Create lesson for course
 */
coursesRouter.post('/:id/lessons', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, content, contentType, mediaUrl, sequenceOrder, durationMinutes, dayNumber, metadata } = req.body;

    const course = await db.courses.findById(id, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    // Get max sequence order if not provided
    let order = sequenceOrder;
    if (order === undefined) {
      const lessons = await db.lessons.findByCourse(id);
      order = lessons.length + 1;
    }

    const lesson = await db.lessons.create({
      courseId: id,
      title,
      content,
      contentType,
      mediaUrl,
      sequenceOrder: order,
      durationMinutes,
      dayNumber: dayNumber ?? 1,
      metadata
    });

    logger.info(`Lesson created: ${lesson.id}`);
    res.json({ success: true, data: lesson });
  } catch (error) {
    logger.error('Error creating lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to create lesson' });
  }
});

/**
 * PUT /api/courses/:courseId/lessons/:lessonId
 * Update lesson
 */
coursesRouter.put('/:courseId/lessons/:lessonId', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { courseId, lessonId } = req.params;
    const { title, content, contentType, mediaUrl, sequenceOrder, durationMinutes, dayNumber, metadata } = req.body;

    const course = await db.courses.findById(courseId, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const lesson = await db.lessons.update(lessonId, {
      title,
      content,
      contentType,
      mediaUrl,
      sequenceOrder,
      durationMinutes,
      dayNumber,
      metadata
    }, courseId);

    if (!lesson) {
      return res.status(404).json({ success: false, error: 'Lesson not found' });
    }

    logger.info(`Lesson updated: ${lessonId}`);
    res.json({ success: true, data: lesson });
  } catch (error) {
    logger.error('Error updating lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to update lesson' });
  }
});

/**
 * DELETE /api/courses/:courseId/lessons/:lessonId
 * Delete lesson
 */
coursesRouter.delete('/:courseId/lessons/:lessonId', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { courseId, lessonId } = req.params;

    const course = await db.courses.findById(courseId, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });
    const lesson = await db.lessons.findById(lessonId);
    if (!lesson || lesson.course_id !== courseId) return res.status(404).json({ success: false, error: 'Lesson not found' });
    await db.lessons.delete(lessonId, courseId);
    logger.info(`Lesson deleted: ${lessonId}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to delete lesson' });
  }
});

/**
 * GET /api/courses/:id/stats
 * Get course statistics
 */
coursesRouter.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const course = await db.courses.findById(id, req.auth!.organizationId);
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const enrollmentStats = await db.enrollments.getStats(id);
    const lessonCount = await db.lessons.countByCourse(id);

    res.json({
      success: true,
      data: {
        ...enrollmentStats,
        lessonCount
      }
    });
  } catch (error) {
    logger.error('Error fetching course stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});
