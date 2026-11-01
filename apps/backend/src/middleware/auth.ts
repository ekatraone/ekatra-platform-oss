/**
 * JWT Authentication Middleware
 *
 * Verifies Bearer tokens on protected routes.
 * Usage: app.use('/api/courses', authMiddleware, coursesRouter);
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
}

/** Admin and learner tokens share a signing key in legacy deployments. */
export function verifyAdminToken(token: string): AuthPayload {
  const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  if (typeof payload === 'string' || payload.role === 'learner' || 'learnerId' in payload ||
      typeof payload.exp !== 'number' ||
      !['userId', 'email', 'role', 'organizationId'].every(key =>
        typeof payload[key] === 'string' && payload[key].trim().length > 0)) {
    throw new Error('Invalid admin token scope');
  }
  return { userId: payload.userId, email: payload.email, role: payload.role, organizationId: payload.organizationId };
}

// Extend Express Request to carry auth info
declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/**
 * Middleware that requires a valid JWT Bearer token.
 * Injects req.auth with decoded payload on success.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = verifyAdminToken(token);
    req.auth = payload;
    next();
  } catch (err) {
    logger.warn('JWT verification failed:', err);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth: attaches req.auth if a valid token is present,
 * but does not reject the request if absent.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.auth = verifyAdminToken(header.slice(7));
    } catch {
      // Ignore invalid tokens for optional auth
    }
  }
  next();
}

/**
 * Sign a JWT for a user. Default TTL is 24 hours — short enough to limit
 * damage from token theft, long enough for a full work session.
 * Use refreshToken() to issue a new token without re-authenticating.
 */
export function signToken(payload: AuthPayload, expiresIn: jwt.SignOptions['expiresIn'] = '24h'): string {
  return jwt.sign(payload, jwtSecret(), { algorithm: 'HS256', expiresIn });
}

/**
 * Require one of the given roles. Must be used AFTER authMiddleware.
 * super_admin always passes.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.auth?.role;
    if (!userRole) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }
    if (userRole === 'super_admin' || roles.includes(userRole)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Insufficient role' });
  };
}
