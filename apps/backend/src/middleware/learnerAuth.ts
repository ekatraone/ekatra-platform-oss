import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

if (!process.env.JWT_SECRET) {
  const msg = 'FATAL: JWT_SECRET environment variable is not set. Set it before starting the server.';
  console.error(msg);
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

export interface LearnerAuthPayload {
  learnerId: string;
  phone: string;
  role: 'learner';
  organizationId: string;
}

declare global {
  namespace Express {
    interface Request {
      learnerAuth?: LearnerAuthPayload;
    }
  }
}

export function learnerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as LearnerAuthPayload;
    if (payload.role !== 'learner') {
      res.status(403).json({ success: false, error: 'Invalid token scope' });
      return;
    }
    req.learnerAuth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function signLearnerToken(payload: LearnerAuthPayload, expiresIn = '24h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as any);
}
