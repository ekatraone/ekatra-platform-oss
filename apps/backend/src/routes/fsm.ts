/**
 * FSM Definition Routes — admin/super_admin only
 *
 * GET    /api/fsm          list all FSM definitions in org
 * GET    /api/fsm/:id      get a single definition with full JSON
 * POST   /api/fsm          create a new FSM definition
 * PUT    /api/fsm/:id      update name and/or fsm_json (bumps version)
 * DELETE /api/fsm/:id      delete a definition (super_admin only)
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

export const fsmRouter: Router = Router();

// All routes require at least admin role
fsmRouter.use(requireRole('admin', 'super_admin'));

// ── GET /api/fsm ─────────────────────────────────────────────────────────────
fsmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const definitions = await db.fsmDefinitions.findAll(req.auth!.organizationId);
    res.json({ success: true, data: definitions });
  } catch (error) {
    logger.error('GET /api/fsm error:', error);
    res.status(500).json({ success: false, error: 'Failed to list FSM definitions' });
  }
});

// ── GET /api/fsm/:id ──────────────────────────────────────────────────────────
fsmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const definition = await db.fsmDefinitions.findById(req.params.id);

    if (!definition || definition.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'FSM definition not found' });
    }

    res.json({ success: true, data: definition });
  } catch (error) {
    logger.error('GET /api/fsm/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch FSM definition' });
  }
});

// ── POST /api/fsm ─────────────────────────────────────────────────────────────
fsmRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { name, fsmJson } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    if (name.length > 255) {
      return res.status(400).json({ success: false, error: 'name too long (max 255 chars)' });
    }

    if (fsmJson !== undefined && JSON.stringify(fsmJson).length > 65536) {
      return res.status(400).json({ success: false, error: 'fsmJson too large (max 64KB)' });
    }

    const db = await getDb();
    const definition = await db.fsmDefinitions.create({
      organizationId: req.auth!.organizationId,
      name: name.trim(),
      fsmJson: fsmJson ?? { states: [], transitions: [] },
      createdBy: req.auth!.userId,
    });

    logger.info(`FSM definition created: "${name}" by ${req.auth!.email}`);
    res.status(201).json({ success: true, data: definition });
  } catch (error) {
    logger.error('POST /api/fsm error:', error);
    res.status(500).json({ success: false, error: 'Failed to create FSM definition' });
  }
});

// ── PUT /api/fsm/:id ──────────────────────────────────────────────────────────
fsmRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, fsmJson } = req.body;

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ success: false, error: 'name cannot be empty' });
    }

    if (name && name.length > 255) {
      return res.status(400).json({ success: false, error: 'name too long (max 255 chars)' });
    }

    if (fsmJson !== undefined && JSON.stringify(fsmJson).length > 65536) {
      return res.status(400).json({ success: false, error: 'fsmJson too large (max 64KB)' });
    }

    const db = await getDb();

    // Org scope check
    const existing = await db.fsmDefinitions.findById(req.params.id);
    if (!existing || existing.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'FSM definition not found' });
    }

    const updated = await db.fsmDefinitions.update(req.params.id, {
      ...(name !== undefined && { name: name.trim() }),
      ...(fsmJson !== undefined && { fsmJson }),
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('PUT /api/fsm/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to update FSM definition' });
  }
});

// ── DELETE /api/fsm/:id ───────────────────────────────────────────────────────
fsmRouter.delete('/:id', requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const db = await getDb();

    // Org scope check
    const existing = await db.fsmDefinitions.findById(req.params.id);
    if (!existing || existing.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'FSM definition not found' });
    }

    await db.fsmDefinitions.delete(req.params.id);
    logger.info(`FSM definition deleted: ${req.params.id} by ${req.auth!.email}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('DELETE /api/fsm/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete FSM definition' });
  }
});

// ── GET /api/fsm/:id/learners ─────────────────────────────────────────────────
// Returns live learner positions: which state each learner is at in this FSM.
fsmRouter.get('/:id/learners', async (req: Request, res: Response) => {
  try {
    const db = await getDb();

    // Org scope check
    const definition = await db.fsmDefinitions.findById(req.params.id);
    if (!definition || definition.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'FSM definition not found' });
    }

    const { query: rawQuery } = await import('@ekatra/database');
    const result = await rawQuery(
      `SELECT
         (l.metadata->'fsm_dynamic'->>'state') AS state_id,
         COUNT(*)::int AS learner_count,
         json_agg(json_build_object('id', l.id, 'phone', l.phone, 'name', l.name)) AS learners
       FROM learners l
       WHERE l.id IN (
         SELECT learner_id FROM enrollments
         WHERE fsm_definition_id = $1 AND status IN ('enrolled', 'in_progress')
       )
       GROUP BY state_id`,
      [req.params.id]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('GET /api/fsm/:id/learners error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch learner positions' });
  }
});
