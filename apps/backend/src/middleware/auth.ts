/**
 * JWT Authentication Middleware
 *
 * Verifies Bearer tokens on protected routes.
 * Usage: app.use('/api/courses', authMiddleware, coursesRouter);
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';

if (!process.env.JWT_SECRET) {
  const msg = 'FATAL: JWT_SECRET environment variable is not set. Set it before starting the server.';
  console.error(msg);
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
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
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
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
      req.auth = jwt.verify(header.slice(7), JWT_SECRET) as AuthPayload;
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
export function signToken(payload: AuthPayload, expiresIn = '24h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as any);
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
