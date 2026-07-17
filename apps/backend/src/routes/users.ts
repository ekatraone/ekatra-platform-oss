/**
 * User management routes — admin/super_admin only
 *
 * GET    /api/users          list all users in org
 * POST   /api/users          invite (create) a new user
 * PUT    /api/users/:id      update name / role
 * DELETE /api/users/:id      remove user (cannot self-delete)
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { requireRole } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

export const usersRouter: Router = Router();

// All routes require at least admin role
usersRouter.use(requireRole('admin', 'super_admin'));

// ── GET /api/users ──────────────────────────────────────────────────────────
usersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    const result = await db.users.findAll({
      organizationId: req.auth!.organizationId,
      page,
      limit,
    });

    res.json({ success: true, data: result.data, total: result.total });
  } catch (error) {
    logger.error('GET /api/users error:', error);
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────
usersRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const user = await db.users.findById(id);
    if (!user || user.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    logger.error('GET /api/users/:id error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user' });
  }
});

// ── POST /api/users ──────────────────────────────────────────────────────────
usersRouter.post('/', requireRole('admin', 'super_admin'), async (req: Request, res: Response) => {
  try {
    const { email, name, role, password } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    if (name && name.length > 255) {
      return res.status(400).json({ success: false, error: 'Name too long (max 255 chars)' });
    }

    const allowedRoles = ['viewer', 'admin', 'super_admin'];
    const userRole = role && allowedRoles.includes(role) ? role : 'viewer';

    // Only super_admin can create another super_admin
    if (userRole === 'super_admin' && req.auth!.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Only super_admin can create another super_admin' });
    }

    const db = await getDb();
    const existing = await db.users.findByEmail(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ success: false, error: 'A user with that email already exists' });
    }

    // Use provided password or generate a cryptographically secure temporary one
    const tempPassword = password || crypto.randomBytes(12).toString('hex') + 'Aa1!';
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await db.users.create({
      organizationId: req.auth!.organizationId,
      email: email.toLowerCase().trim(),
      passwordHash,
      name: name || email.split('@')[0],
      role: userRole,
    });

    logger.info(`User created: ${email} (${userRole}) by ${req.auth!.email}`);

    // Prevent caching of response containing temporary credentials
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      data: user,
      // Return temp password so admin can share it — only on creation, no password supplied
      ...(password ? {} : { temporaryPassword: tempPassword }),
    });
  } catch (error) {
    logger.error('POST /api/users error:', error);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// ── PUT /api/users/:id ───────────────────────────────────────────────────────
usersRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, role } = req.body;

    if (name && name.length > 255) {
      return res.status(400).json({ success: false, error: 'Name too long (max 255 chars)' });
    }

    if (role === 'super_admin' && req.auth!.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Only super_admin can promote to super_admin' });
    }

    const db = await getDb();

    // IDOR guard: verify user belongs to requester's organization
    const target = await db.users.findById(id);
    if (!target || target.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const updated = await db.users.update(id, { name, role });

    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('PUT /api/users error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ── DELETE /api/users/:id ────────────────────────────────────────────────────
usersRouter.delete('/:id', requireRole('super_admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (id === req.auth!.userId) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }

    const db = await getDb();

    // IDOR guard: verify user belongs to requester's organization
    const target = await db.users.findById(id);
    if (!target || target.organization_id !== req.auth!.organizationId) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await db.users.delete(id);

    res.json({ success: true });
  } catch (error) {
    logger.error('DELETE /api/users error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});
