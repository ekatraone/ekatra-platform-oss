/**
 * Admin Operations API Routes
 *
 * Pilot operations: reset learner FSM state, inspect state, trigger manual lesson.
 * All routes require JWT (authMiddleware applied at registration in index.ts).
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then(m => m.db);
const getFSM = () => import('../flows/conversationFSM.js').then(m => m.ConversationFSM);

export const adminRouter: Router = Router();

// ─── GET /api/admin/learners/:id/state ────────────────────────────────────────
// Return the current FSM state + metadata for a learner (by ID or phone).

adminRouter.get('/learners/:id/state', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    // Accept phone number or UUID
    const learner = id.match(/^\d+$/)
      ? await db.learners.findByPhone(id)
      : await db.learners.findById(id);

    if (!learner) {
      res.status(404).json({ success: false, error: 'Learner not found' });
      return;
    }

    const fsm = (learner.metadata as any)?.fsm ?? { state: 'idle', data: {}, version: 0 };

    res.json({
      success: true,
      data: {
        id: learner.id,
        phone: learner.phone,
        name: learner.name,
        fsm,
      },
    });
  } catch (error) {
    logger.error('Admin: error fetching learner state:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch learner state' });
  }
});

// ─── POST /api/admin/learners/:id/reset ───────────────────────────────────────
// Reset a learner's FSM state to idle (preserves enrollments and message log).
// Body: { deleteHistory?: boolean } — if true, also deletes enrollments + lesson progress.

adminRouter.post('/learners/:id/reset', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { deleteHistory = false } = req.body as { deleteHistory?: boolean };

    const learner = id.match(/^\d+$/)
      ? await db.learners.findByPhone(id)
      : await db.learners.findById(id);

    if (!learner) {
      res.status(404).json({ success: false, error: 'Learner not found' });
      return;
    }

    // Reset FSM to idle — unconditional (bypasses optimistic locking)
    await db.raw(
      `UPDATE learners
       SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{fsm}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ state: 'idle', data: {}, version: 0 }), learner.id]
    );

    if (deleteHistory) {
      await db.raw('DELETE FROM lesson_progress WHERE enrollment_id IN (SELECT id FROM enrollments WHERE learner_id = $1)', [learner.id]);
      await db.raw('DELETE FROM enrollments WHERE learner_id = $1', [learner.id]);
      logger.info(`Admin: full reset for learner ${learner.id} (${learner.phone}) — enrollments and progress cleared`);
    } else {
      logger.info(`Admin: FSM reset for learner ${learner.id} (${learner.phone}) → idle`);
    }

    res.json({
      success: true,
      data: {
        id: learner.id,
        phone: learner.phone,
        resetType: deleteHistory ? 'full' : 'fsm_only',
        newState: 'idle',
      },
    });
  } catch (error) {
    logger.error('Admin: error resetting learner:', error);
    res.status(500).json({ success: false, error: 'Failed to reset learner' });
  }
});

// ─── POST /api/admin/learners/:id/send ────────────────────────────────────────
// Manually send a single text message to a learner (for pilot ops / debugging).
// Body: { message: string }

adminRouter.post('/learners/:id/send', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const messaging = await import('@ekatra/messaging').then(m => m.messaging);
    const { id } = req.params;
    const { message } = req.body as { message?: string };

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ success: false, error: 'message is required' });
      return;
    }
    if (message.length > 4096) {
      res.status(400).json({ success: false, error: 'message exceeds 4096 character limit' });
      return;
    }

    const learner = id.match(/^\d+$/)
      ? await db.learners.findByPhone(id)
      : await db.learners.findById(id);

    if (!learner) {
      res.status(404).json({ success: false, error: 'Learner not found' });
      return;
    }

    const result = await messaging.sendText(learner.phone, { text: message.trim() });

    logger.info(`Admin: manual send to ${learner.phone} — ${result.success ? 'OK' : 'FAILED'}`);

    res.json({ success: true, data: { to: learner.phone, result } });
  } catch (error) {
    logger.error('Admin: error sending message:', error);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// ─── POST /api/admin/simulate ──────────────────────────────────────────────
// Simulate an inbound WhatsApp message — calls messageHandler.handle directly,
// bypassing Twilio signature validation. Useful for manual testing and CI.
// Body: { phone: string, text?: string, buttonPayload?: string, profileName?: string }

adminRouter.post('/simulate', async (req: Request, res: Response) => {
  try {
    const { phone, text, buttonPayload, profileName = 'Simulated User' } = req.body;

    if (!phone) {
      res.status(400).json({ success: false, error: 'phone is required' });
      return;
    }
    if (!text && !buttonPayload) {
      res.status(400).json({ success: false, error: 'text or buttonPayload is required' });
      return;
    }

    const { MessageHandler } = await import('../services/messageHandler.js');
    const handler = new MessageHandler();
    await handler.handle({
      from: phone,
      name: profileName,
      type: buttonPayload ? 'button' : 'text',
      text: buttonPayload ? undefined : text,
      buttonPayload,
    });

    logger.info(`Admin: simulated message from ${phone}: "${text || buttonPayload}"`);
    res.json({ success: true, data: { phone, text, buttonPayload } });
  } catch (error) {
    logger.error('Admin: simulation error:', error);
    res.status(500).json({ success: false, error: 'Simulation failed' });
  }
});
