/**
 * Auth Routes
 *
 * POST /api/auth/login  — email + password → JWT
 * POST /api/auth/verify — validate a token + return user info
 * POST /api/auth/seed   — create the default admin user (run once)
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signToken, authMiddleware } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

export const authRouter: Router = Router();

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns: { token, user }
 */
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const db = await getDb();
    const user = await db.users.findByEmail(email.toLowerCase().trim());

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash || '');
    if (!passwordValid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organization_id,
    });

    logger.info(`✅ Login: ${email}`);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organization_id,
      },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

/**
 * POST /api/auth/refresh
 * Exchanges a still-valid JWT for a new one with a fresh 24h expiry.
 * This allows the frontend to silently extend sessions without re-login.
 */
authRouter.post('/refresh', authMiddleware, (req: Request, res: Response) => {
  // authMiddleware already verified the token — just re-sign with a fresh expiry.
  const { userId, email, role, organizationId } = req.auth!;
  const token = signToken({ userId, email, role, organizationId });
  res.json({ success: true, token });
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile.
 */
authRouter.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const user = await db.users.findById(req.auth!.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organization_id,
      },
    });
  } catch (error) {
    logger.error('Me error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

/**
 * POST /api/auth/seed
 * Creates the default admin user if none exists.
 * Protected by ADMIN_SEED_KEY env variable (one-time setup).
 */
authRouter.post('/seed', async (req: Request, res: Response) => {
  try {
    const { seedKey, email, password, name, role } = req.body;

    const expectedKey = process.env.ADMIN_SEED_KEY;
    if (!expectedKey || seedKey !== expectedKey) {
      return res.status(403).json({ success: false, error: 'Invalid seed key' });
    }

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    // Allow seeding admin or super_admin; default to admin
    const allowedRoles = ['admin', 'super_admin'];
    const seedRole = role && allowedRoles.includes(role) ? role : 'admin';

    const db = await getDb();

    const existing = await db.users.findByEmail(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    // Ensure a default organisation exists
    let org = await db.organizations.getDefault();
    if (!org) {
      const result = await db.raw(
        `INSERT INTO organizations (name, slug, settings) VALUES ($1, $2, $3) RETURNING *`,
        ['Ekatra', 'ekatra', {}],
      );
      org = result.rows[0];
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await db.users.create({
      organizationId: org.id,
      email: email.toLowerCase().trim(),
      passwordHash,
      name: name || 'Admin',
      role: seedRole,
    });

    logger.info(`🔑 ${seedRole} user seeded: ${email}`);

    res.status(201).json({
      success: true,
      message: `${seedRole} user created`,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (error) {
    logger.error('Seed error:', error);
    res.status(500).json({ success: false, error: 'Seed failed' });
  }
});
