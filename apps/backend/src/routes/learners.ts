/**
 * Learners API Routes
 * 
 * Manage learners, enrollments, and progress
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

// Lazy imports to avoid circular dependencies
const getDb = () => import('@ekatra/database').then(m => m.db);
const getMessaging = () => import('@ekatra/messaging').then(m => m.messaging);

export const learnersRouter: Router = Router();

/**
 * GET /api/learners
 * List all learners with filters
 */
learnersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { organizationId, status, search, page = 1, limit = 50 } = req.query;

    const learners = await db.learners.findAll({
      organizationId: organizationId as string,
      status: status as string,
      search: search as string,
      page: Number(page),
      limit: Number(limit)
    });

    res.json({
      success: true,
      data: learners.data,
      pagination: learners.pagination
    });
  } catch (error) {
    logger.error('Error fetching learners:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch learners' });
  }
});

/**
 * GET /api/learners/by-phone/:phone/messages
 * Get message history for a learner looked up by phone number
 * (must be before /:id to avoid param capture)
 */
learnersRouter.get('/by-phone/:phone/messages', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { phone } = req.params;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const learner = await db.learners.findByPhone(phone);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    const messages = await db.messageLog.findByLearner(learner.id, limit);
    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error('Error fetching messages by phone:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/learners/bulk-enroll
 * Enroll multiple learners in a course by phone/waId list
 * (must be before /:id to avoid param capture)
 */
learnersRouter.post('/bulk-enroll', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { waIds, courseId, sendWelcome = false } = req.body;

    if (!Array.isArray(waIds) || waIds.length === 0) {
      return res.status(400).json({ success: false, error: 'waIds array is required' });
    }
    if (!courseId) {
      return res.status(400).json({ success: false, error: 'courseId is required' });
    }

    const course = await db.courses.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const lessons = await db.lessons.findByCourse(courseId);
    const firstLesson = lessons[0];

    const results: { waId: string; status: string; learnerId?: string }[] = [];

    for (const waId of waIds) {
      try {
        let learner = await db.learners.findByPhone(waId);
        if (!learner) {
          const org = await db.organizations.getDefault();
          learner = await db.learners.create({
            organizationId: org?.id,
            phone: waId,
            whatsappId: waId,
            language: 'en',
          });
        }

        const existing = await db.enrollments.find(learner.id, courseId);
        if (existing) {
          results.push({ waId, status: 'already_enrolled', learnerId: learner.id });
          continue;
        }

        const enrollment = await db.enrollments.create({ learnerId: learner.id, courseId, status: 'enrolled' });
        if (firstLesson) {
          await db.enrollments.update(enrollment.id, { currentLessonId: firstLesson.id, status: 'in_progress' });
        }

        if (sendWelcome && learner.phone) {
          const messaging = await getMessaging();
          await messaging.sendText(learner.phone, {
            text: `🎉 You've been enrolled in *${course.title}*!\n\nType "Start Day" to begin learning.`,
          });
        }

        results.push({ waId, status: 'enrolled', learnerId: learner.id });
      } catch (err) {
        logger.error(`Bulk enroll error for ${waId}:`, err);
        results.push({ waId, status: 'error' });
      }
    }

    const enrolled = results.filter(r => r.status === 'enrolled').length;
    logger.info(`Bulk enroll: ${enrolled}/${waIds.length} enrolled in course ${courseId}`);
    res.json({ success: true, data: results, enrolled, total: waIds.length });
  } catch (error) {
    logger.error('Error bulk enrolling learners:', error);
    res.status(500).json({ success: false, error: 'Failed to bulk enroll' });
  }
});

/**
 * GET /api/learners/:id
 * Get single learner with enrollments and progress
 */
learnersRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const learner = await db.learners.findById(id);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    // Get enrollments
    const enrollments = await db.enrollments.findByLearner(id);
    
    // Get recent messages
    const messages = await db.messageLog.findByLearner(id, 50);

    res.json({
      success: true,
      data: {
        ...learner,
        enrollments,
        recentMessages: messages
      }
    });
  } catch (error) {
    logger.error('Error fetching learner:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch learner' });
  }
});

/**
 * POST /api/learners
 * Create/register learner manually
 */
learnersRouter.post('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { organizationId, phone, name, email, whatsappId, language } = req.body;

    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number is required' 
      });
    }

    // Get default organization if not provided
    let orgId = organizationId;
    if (!orgId) {
      const org = await db.organizations.getDefault();
      orgId = org?.id;
    }

    // Check if already exists
    let learner = await db.learners.findByPhone(phone, orgId);
    if (learner) {
      return res.status(409).json({
        success: false,
        error: 'Learner already exists',
        data: learner
      });
    }

    // Create new learner
    learner = await db.learners.create({
      organizationId: orgId,
      phone,
      name,
      email,
      whatsappId: whatsappId || phone,
      language: language || 'en'
    });

    logger.info(`Learner created: ${learner.id}`);
    res.json({ success: true, data: learner });
  } catch (error) {
    logger.error('Error creating learner:', error);
    res.status(500).json({ success: false, error: 'Failed to create learner' });
  }
});

/**
 * PUT /api/learners/:id
 * Update learner
 */
learnersRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { name, email, timezone, language, status, metadata } = req.body;

    const learner = await db.learners.update(id, {
      name,
      email,
      timezone,
      language,
      status,
      metadata
    });

    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    logger.info(`Learner updated: ${id}`);
    res.json({ success: true, data: learner });
  } catch (error) {
    logger.error('Error updating learner:', error);
    res.status(500).json({ success: false, error: 'Failed to update learner' });
  }
});

/**
 * POST /api/learners/:id/enroll
 * Enroll learner in a course
 */
learnersRouter.post('/:id/enroll', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const messaging = await getMessaging();
    
    const { id } = req.params;
    const { courseId, startImmediately = false } = req.body;

    if (!courseId) {
      return res.status(400).json({ success: false, error: 'Course ID is required' });
    }

    const learner = await db.learners.findById(id);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    const course = await db.courses.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    // Copy FSM definition from the course (null if course has no FSM assigned)
    const fsmDefinitionId: string | null = course.fsm_definition_id ?? null;

    // Get first lesson
    const lessons = await db.lessons.findByCourse(courseId);
    const firstLesson = lessons[0];

    // Upsert: if already enrolled, update the FSM definition and reset to active
    const existing = await db.enrollments.find(id, courseId);
    let enrollment: any;
    if (existing) {
      enrollment = await db.enrollments.update(existing.id, {
        fsmDefinitionId,
        status: firstLesson ? 'in_progress' : 'enrolled',
        currentLessonId: firstLesson?.id ?? undefined,
      });
      logger.info(`Learner ${id} re-enrolled in course ${courseId} (fsm: ${fsmDefinitionId})`);
    } else {
      enrollment = await db.enrollments.create({
        learnerId: id,
        courseId,
        status: 'enrolled',
        fsmDefinitionId,
      });
      if (firstLesson) {
        enrollment = await db.enrollments.update(enrollment.id, {
          currentLessonId: firstLesson.id,
          status: 'in_progress',
        });
      }
      logger.info(`Learner ${id} enrolled in course ${courseId} (fsm: ${fsmDefinitionId})`);
    }

    // Optionally send Day 1 immediately
    if (startImmediately && learner.phone) {
      try {
        const { CourseDeliveryService } = await import('../services/courseDelivery.js');
        const delivery = new CourseDeliveryService();
        await delivery.sendNextLesson(learner.phone, enrollment);
      } catch (deliveryErr) {
        logger.error(`startImmediately delivery failed for learner ${id}:`, deliveryErr);
        // Non-fatal — enrollment succeeded, lesson delivery failed
      }
    } else if (learner.phone) {
      await messaging.sendText(learner.phone, {
        text: `🎉 You're enrolled in *${course.title}*!\n\nType "Start Day" to begin learning.`
      });
    }

    res.json({ success: true, data: enrollment });
  } catch (error) {
    logger.error('Error enrolling learner:', error);
    res.status(500).json({ success: false, error: 'Failed to enroll learner' });
  }
});

/**
 * POST /api/learners/:id/unenroll
 * Unenroll learner from their active course
 */
learnersRouter.post('/:id/unenroll', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const learner = await db.learners.findById(id);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    // Mark all active enrollments as unenrolled
    const enrollments = await db.enrollments.findByLearner(id);
    const active = enrollments.filter((e: any) => e.status === 'enrolled' || e.status === 'in_progress');

    for (const enrollment of active) {
      await db.enrollments.update(enrollment.id, { status: 'unenrolled' });
    }

    logger.info(`Learner ${id} unenrolled (${active.length} enrollments updated)`);
    res.json({ success: true, data: { unenrolled: active.length } });
  } catch (error) {
    logger.error('Error unenrolling learner:', error);
    res.status(500).json({ success: false, error: 'Failed to unenroll learner' });
  }
});

/**
 * GET /api/learners/:id/enrollments
 * Get learner enrollments
 */
learnersRouter.get('/:id/enrollments', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const enrollments = await db.enrollments.findByLearner(id);
    res.json({ success: true, data: enrollments });
  } catch (error) {
    logger.error('Error fetching enrollments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch enrollments' });
  }
});

/**
 * GET /api/learners/:id/progress
 * Get progress across all enrollments for a learner
 */
learnersRouter.get('/:id/progress', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const enrollments = await db.enrollments.findByLearner(id);
    const progressByEnrollment = await Promise.all(
      enrollments.map(async (enrollment: any) => {
        const progress = await db.lessonProgress.findByEnrollment(enrollment.id);
        return { enrollment, progress };
      })
    );

    res.json({ success: true, data: progressByEnrollment });
  } catch (error) {
    logger.error('Error fetching learner progress:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress' });
  }
});

/**
 * GET /api/learners/:id/progress/:enrollmentId
 * Get learner progress in a specific course
 */
learnersRouter.get('/:id/progress/:enrollmentId', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { enrollmentId } = req.params;

    const progress = await db.lessonProgress.findByEnrollment(enrollmentId);
    res.json({ success: true, data: progress });
  } catch (error) {
    logger.error('Error fetching progress:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress' });
  }
});

/**
 * POST /api/learners/:id/send-message
 * Send WhatsApp message to learner
 */
learnersRouter.post('/:id/send-message', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const messaging = await getMessaging();
    
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const learner = await db.learners.findById(id);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    if (!learner.phone) {
      return res.status(400).json({ success: false, error: 'Learner has no phone number' });
    }

    await messaging.sendText(learner.phone, { text: message });
    
    // Log the message
    await db.messageLog.create({
      learnerId: id,
      direction: 'outbound',
      messageType: 'text',
      content: message,
      status: 'sent'
    });

    logger.info(`Message sent to learner ${id}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

/**
 * GET /api/learners/:id/messages
 * Get learner message history
 */
learnersRouter.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { limit = 50 } = req.query;

    const messages = await db.messageLog.findByLearner(id, Number(limit));
    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

/**
 * GET /api/learners/stats
 * Get learner statistics
 */
learnersRouter.get('/stats/overview', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { organizationId } = req.query;

    const stats = await db.learners.getStats(organizationId as string);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Error fetching learner stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});
