/**
 * Courses API Routes
 * 
 * CRUD for courses and lessons
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

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
    const { organizationId, status, search, page = 1, limit = 20 } = req.query;
    
    const courses = await db.courses.findAll({
      organizationId: organizationId as string,
      status: status as string,
      search: search as string,
      page: Number(page),
      limit: Number(limit)
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
    
    const course = await db.courses.findById(id);
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
    const { organizationId, title, description, category, status, createdBy } = req.body;

    if (!title) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title is required' 
      });
    }

    // Get default organization if not provided
    let orgId = organizationId;
    if (!orgId) {
      const org = await db.organizations.getDefault();
      orgId = org?.id;
    }

    const course = await db.courses.create({
      organizationId: orgId,
      title,
      description,
      category,
      status: status || 'draft',
      createdBy
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
coursesRouter.post('/lessons/:lessonId/send-media', async (req: Request, res: Response) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Missing "to" (learner address)' });
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

    // Resolve organization
    const { organizationId: orgFromBody } = req.body;
    let organizationId: string | undefined = orgFromBody;
    if (!organizationId) {
      const org = await db.organizations.getDefault();
      organizationId = org?.id;
    }
    if (!organizationId) {
      return res.status(500).json({ success: false, error: 'No organization configured' });
    }

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

    const course = await db.courses.update(id, {
      title,
      description,
      category,
      status,
      settings,
      fsm_definition_id
    });

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

    await db.courses.delete(id);
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

    const course = await db.courses.update(id, { status: 'published' });
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

    const course = await db.courses.update(id, { status: 'draft' });
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

    const originalCourse = await db.courses.findById(id);
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
    const { lessonId } = req.params;
    const { title, content, contentType, mediaUrl, sequenceOrder, durationMinutes, dayNumber, metadata } = req.body;

    const lesson = await db.lessons.update(lessonId, {
      title,
      content,
      contentType,
      mediaUrl,
      sequenceOrder,
      durationMinutes,
      dayNumber,
      metadata
    });

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
    const { lessonId } = req.params;

    await db.lessons.delete(lessonId);
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
