/**
 * Sync routes — Maya offline app ↔ backend. Learner JWT auth (not the admin JWT).
 *
 * GET  /api/sync/me
 * POST /api/sync/lessons/request
 * GET  /api/sync/courses/:courseId/bundle
 * POST /api/sync/events
 *
 * Contract: .claude/hackathon/CONTRACT.md
 *
 * The learner token is verified inline with JWT_SECRET read at request time:
 * middleware/learnerAuth.ts exits the process at import when the secret is unset.
 */

import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { logger } from '../lib/logger.js';
import { FirebaseAuthLike, firebaseUnavailableBody, getFirebaseAuth } from '../lib/firebaseAdmin.js';
import {
  E164_RE,
  MAX_NAME_LENGTH,
  findLearnerByFirebaseUid,
  findLearnerByPhone,
  findOrCreateLearnerByFirebaseUid,
  findOrCreateLearnerByPhone,
  signLearnerToken,
} from '../services/learnerIdentity.js';
import { deleteLearnerAccount } from '../services/accountDeletion.js';
import { resolveFirebaseIdentity } from '../services/firebaseIdentity.js';
import {
  SyncDb,
  SyncLearner,
  CourseGeneratorLike,
  SyncError,
  requestLesson,
  buildBundle,
  applyEvents,
  getMe,
  isUuid,
} from '../services/syncService.js';

export interface SyncRouterDeps {
  db: SyncDb;
  generator: CourseGeneratorLike;
  /** Firebase Admin for /auth/exchange; defaults to the lazily-initialized real one. */
  firebase?: () => FirebaseAuthLike | null;
}

type SyncRequest = Request & { syncLearner?: SyncLearner };

/**
 * Verifies the learner JWT and that the learner still exists in the token's organization,
 * so a token for a deleted learner (or a forged id) stops working immediately.
 */
function learnerAuth(db: SyncDb) {
  return async (req: SyncRequest, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
      return;
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ success: false, error: 'Server auth is not configured' });
      return;
    }
    let payload: any;
    try {
      payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
    } catch {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
      return;
    }
    // Tokens must expire, and carry well-formed ids (they are used as SQL uuid parameters).
    if (
      payload?.role !== 'learner' ||
      typeof payload.exp !== 'number' ||
      !isUuid(payload.learnerId) ||
      !isUuid(payload.organizationId)
    ) {
      res.status(401).json({ success: false, error: 'Invalid token' });
      return;
    }
    try {
      const found = await db.raw(`SELECT 1 FROM learners WHERE id = $1 AND organization_id = $2`, [
        payload.learnerId,
        payload.organizationId,
      ]);
      if (!found.rows.length) {
        res.status(401).json({ success: false, error: 'Unknown learner' });
        return;
      }
    } catch (err) {
      logger.error('sync auth lookup failed', err);
      res.status(500).json({ success: false, error: 'Internal error' });
      return;
    }
    req.syncLearner = { id: payload.learnerId, organizationId: payload.organizationId, phone: payload.phone };
    next();
  };
}

const perLearner = (max: number, windowMs: number) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as SyncRequest).syncLearner?.id ?? 'anonymous',
    message: { success: false, error: 'Rate limit exceeded. Please try again later.' },
  });

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof SyncError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  logger.error(`sync ${what} failed`, err);
  res.status(500).json({ success: false, error: 'Internal error' });
}

export const MIN_INVITE_CODE_LENGTH = 16;

/**
 * Tester sign-in is a testing fallback. It is on only when DEMO_INVITE_CODE is set AND is at least
 * 16 characters; and in production only when ALLOW_TESTER_JOIN=1 is also set.
 */
export function testerJoinEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const code = env.DEMO_INVITE_CODE;
  if (!code || code.length < MIN_INVITE_CODE_LENGTH) return false;
  if (env.NODE_ENV === 'production' && env.ALLOW_TESTER_JOIN !== '1') return false;
  return true;
}

export function createSyncRouter({ db, generator, firebase = getFirebaseAuth }: SyncRouterDeps): Router {
  const router = Router();

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TESTER_JOIN === '1' && process.env.DEMO_INVITE_CODE) {
    logger.warn('Tester sign-in (/api/sync/join) is ENABLED in production: ALLOW_TESTER_JOIN=1 and DEMO_INVITE_CODE are both set');
  }

  // Public, registered before the auth middleware: Twilio/WhatsApp fetch these by URL. The
  // unguessable UUID is the capability; anything that isn't a UUID is a plain 404. It is exempt
  // from the global API limiter in index.ts and has its own per-IP limit instead.
  const mediaLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Rate limit exceeded. Please try again later.' },
  });
  router.get('/media/:id', mediaLimiter, async (req: Request, res: Response) => {
    try {
      if (!isUuid(req.params.id)) {
        res.status(404).json({ success: false, error: 'Not found' });
        return;
      }
      const found = await db.raw(`SELECT mime, bytes FROM lesson_media WHERE id = $1`, [req.params.id]);
      const row = found.rows[0];
      if (!row) {
        res.status(404).json({ success: false, error: 'Not found' });
        return;
      }
      // Media rows are immutable, so the id itself is a perfect strong validator.
      const etag = `"${req.params.id.toLowerCase()}"`;
      res.set({ ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' });
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
        res.status(304).end();
        return;
      }
      res.set({ 'Content-Type': row.mime || 'image/jpeg', 'Content-Length': String(row.bytes.length) });
      res.send(row.bytes);
    } catch (err) {
      fail(res, err, 'media');
    }
  });

  // ── Tester sign-in (public) ────────────────────────────────────────────────
  // Disabled (404) unless DEMO_INVITE_CODE is set. The phone number is NOT verified: anyone with
  // the invite code can claim any number, which is acceptable for a short invited test.
  const joinIpLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts. Please try again later.' },
  });
  // Counted only after the invite code checks out, so a stranger guessing codes against a number
  // cannot lock that number's real owner out.
  const joinPhoneLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as Request & { joinPhone?: string }).joinPhone ?? 'unknown',
    message: { success: false, error: 'Too many attempts for this number. Please try again later.' },
  });
  const digest = (v: string) => createHash('sha256').update(v).digest();

  router.post(
    '/join',
    (req: Request, res: Response, next: NextFunction) => {
      if (!testerJoinEnabled()) {
        res.status(404).json({ success: false, error: 'Not found' });
        return;
      }
      next();
    },
    joinIpLimiter,
    (req: Request & { joinPhone?: string }, res: Response, next: NextFunction) => {
      const { inviteCode, phone, name } = req.body ?? {};
      // Constant-time comparison of fixed-length digests; the message never says which part was wrong.
      const codeOk =
        typeof inviteCode === 'string' && timingSafeEqual(digest(inviteCode), digest(process.env.DEMO_INVITE_CODE!));
      if (!codeOk) {
        res.status(401).json({ success: false, error: 'Invalid invite code' });
        return;
      }
      if (typeof phone !== 'string' || !E164_RE.test(phone)) {
        res.status(400).json({ success: false, error: 'phone must be in international format, e.g. +919876543210' });
        return;
      }
      if (name !== undefined && (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH)) {
        res.status(400).json({ success: false, error: `name must be at most ${MAX_NAME_LENGTH} characters` });
        return;
      }
      req.joinPhone = phone;
      next();
    },
    joinPhoneLimiter,
    async (req: Request, res: Response) => {
      try {
        const { phone, name } = req.body;
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          res.status(500).json({ success: false, error: 'Server auth is not configured' });
          return;
        }
        const result = await findOrCreateLearnerByPhone(db, { phone, name: typeof name === 'string' ? name : null });
        if (!result) {
          res.status(500).json({ success: false, error: 'Sign-in is not available right now' });
          return;
        }
        const { learner } = result;
        res.json({
          success: true,
          data: {
            token: signLearnerToken(learner, secret),
            learner: { id: learner.id, name: learner.name ?? null, phone },
          },
        });
      } catch (err) {
        fail(res, err, 'join');
      }
    },
  );

  // ── Firebase ID token → learner JWT (public) ───────────────────────────────
  router.post(
    '/auth/exchange',
    rateLimit({
      windowMs: 15 * 60_000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Too many attempts. Please try again later.' },
    }),
    async (req: Request, res: Response) => {
      try {
        const auth = firebase();
        if (!auth) {
          res.status(503).json(firebaseUnavailableBody());
          return;
        }
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          res.status(503).json({ success: false, error: 'Sign-in is not available right now' });
          return;
        }
        const idToken = req.body?.idToken;
        if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
          res.status(400).json({ success: false, error: 'idToken is required' });
          return;
        }
        let decoded: Record<string, any>;
        try {
          decoded = await auth.verifyIdToken(idToken, true); // true: reject revoked tokens
        } catch {
          res.status(401).json({ success: false, error: 'Invalid token' });
          return;
        }
        const identity = resolveFirebaseIdentity(decoded);
        if (!identity) {
          res.status(401).json({ success: false, error: 'Invalid token' });
          return;
        }
        const { uid, phone } = identity;

        const name = typeof decoded.name === 'string' ? decoded.name : null;
        const email = typeof decoded.email === 'string' ? decoded.email : null;
        const result = phone
          ? await findOrCreateLearnerByPhone(db, { phone, name })
          : await findOrCreateLearnerByFirebaseUid(db, { uid, name, email });
        if (!result) {
          res.status(500).json({ success: false, error: 'Sign-in is not available right now' });
          return;
        }
        const { learner } = result;
        res.json({
          success: true,
          data: {
            token: signLearnerToken(learner, secret),
            learner: { id: learner.id, name: learner.name ?? null, phone: phone ?? null, email: learner.email ?? email },
          },
        });
      } catch (err) {
        fail(res, err, 'auth/exchange');
      }
    },
  );

  // ── Account deletion without a learner token (public) ──────────────────────────
  // For a user whose learner JWT is gone (never opened Lessons on this device, expired, signed in on
  // another phone): a Firebase ID token proves who they are. The learner is resolved exactly as the
  // exchange does, but only LOOKED UP, never created. Revocation is not checked, so a user in the
  // middle of deleting their Firebase account can still finish here.
  //
  // Also served as POST /auth/account/delete: Android's HttpURLConnection refuses a body on DELETE
  // on many versions. Both routes share one handler and one limiter (5/hour per IP in total).
  const accountDeleteLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts. Please try again later.' },
  });
  const deleteAccountByIdToken = async (req: Request, res: Response) => {
    try {
      const auth = firebase();
      if (!auth) {
        res.status(503).json(firebaseUnavailableBody());
        return;
      }
      const idToken = req.body?.idToken;
      if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
        res.status(400).json({ success: false, error: 'idToken is required' });
        return;
      }
      let identity;
      try {
        identity = resolveFirebaseIdentity(await auth.verifyIdToken(idToken, false));
      } catch {
        identity = null;
      }
      if (!identity) {
        res.status(401).json({ success: false, error: 'Invalid token' });
        return;
      }
      const learner = identity.phone
        ? await findLearnerByPhone(db, identity.phone)
        : await findLearnerByFirebaseUid(db, identity.uid);
      const deleted = learner ? await deleteLearnerAccount(db, learner.id, learner.organization_id) : false;
      // `deleted` is repeated at the top level for clients that read it there.
      res.json({ success: true, deleted, data: { deleted } });
    } catch (err) {
      fail(res, err, 'auth/account');
    }
  };
  router.delete('/auth/account', accountDeleteLimiter, deleteAccountByIdToken);
  router.post('/auth/account/delete', accountDeleteLimiter, deleteAccountByIdToken);

  router.use(learnerAuth(db));

  // Account deletion with the learner token. The work (and the explanation of what goes) lives in
  // services/accountDeletion.ts, shared with DELETE /auth/account. Once the learners row is gone the
  // JWT stops working (learnerAuth looks the row up).
  router.delete('/me', perLearner(5, 60 * 60_000), async (req: SyncRequest, res: Response) => {
    try {
      const learner = req.syncLearner!;
      if (!(await deleteLearnerAccount(db, learner.id, learner.organizationId))) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err, 'delete me');
    }
  });

  router.get('/me', perLearner(60, 60_000), async (req: SyncRequest, res: Response) => {
    try {
      res.json({ success: true, data: await getMe(db, req.syncLearner!) });
    } catch (err) {
      fail(res, err, 'me');
    }
  });

  router.post('/lessons/request', perLearner(20, 60_000), async (req: SyncRequest, res: Response) => {
    try {
      // Muse can take up to 240 s; keep the socket open past node's default.
      req.setTimeout(330_000); // above the client's 300 s read timeout
      const data = await requestLesson(db, generator, req.syncLearner!, req.body ?? {});
      res.json({ success: true, data });
    } catch (err) {
      fail(res, err, 'lessons/request');
    }
  });

  router.get('/courses/:courseId/bundle', perLearner(60, 60_000), async (req: SyncRequest, res: Response) => {
    try {
      res.json({ success: true, data: await buildBundle(db, req.syncLearner!, req.params.courseId) });
    } catch (err) {
      fail(res, err, 'bundle');
    }
  });

  router.post('/events', perLearner(120, 60_000), async (req: SyncRequest, res: Response) => {
    try {
      const data = await applyEvents(db, req.syncLearner!, req.body?.events);
      res.json({ success: true, data });
    } catch (err) {
      fail(res, err, 'events');
    }
  });

  return router;
}

/** Production wiring: the real database pool and the course generator, loaded lazily. */
export function createDefaultSyncRouter(): Router {
  const lazy = {
    raw: async (sql: string, params?: any[]) => (await import('@ekatra/database')).db.raw(sql, params),
  };
  const generator: CourseGeneratorLike = {
    generate: async (params) => (await import('../services/courseGenerator.js')).courseGenerator.generate(params),
  };
  return createSyncRouter({ db: lazy as SyncDb, generator });
}
