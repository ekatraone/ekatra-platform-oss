import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { learnerAuthMiddleware } from '../middleware/learnerAuth.js';
import { MessageHandler } from '../services/messageHandler.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

const messageHandler = new MessageHandler();

export const learnerWebRouter: Router = Router();

learnerWebRouter.use(learnerAuthMiddleware);

learnerWebRouter.get('/profile', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const learner = await db.learners.findById(req.learnerAuth!.learnerId);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    const enrollments = await db.enrollments.findByLearner(learner.id);
    const activeEnrollment = enrollments.find((e: any) => e.status === 'enrolled' || e.status === 'in_progress') || null;

    res.json({
      success: true,
      data: {
        id: learner.id,
        name: learner.name,
        phone: learner.phone,
        language: learner.language,
        metadata: learner.metadata,
        activeEnrollment,
      },
    });
  } catch (error) {
    logger.error('Learner profile fetch failed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

learnerWebRouter.get('/messages', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const messages = await db.messageLog.findByLearner(req.learnerAuth!.learnerId, limit);
    res.json({ success: true, data: messages.reverse() });
  } catch (error) {
    logger.error('Learner message fetch failed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

learnerWebRouter.post('/messages', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, error: 'text is required' });
    }

    const learner = await db.learners.findById(req.learnerAuth!.learnerId);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    await messageHandler.handle({
      from: learner.phone,
      name: learner.name || undefined,
      type: 'text',
      text,
    });

    const messages = await db.messageLog.findByLearner(learner.id, 60);
    res.json({ success: true, data: messages.reverse() });
  } catch (error) {
    logger.error('Learner send message failed:', error);
    res.status(500).json({ success: false, error: 'Failed to process message' });
  }
});
