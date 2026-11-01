/**
 * WhatsApp phone sign-in (public).
 *
 * POST /api/auth/whatsapp/start   { phone }        → sends a 6-digit code on WhatsApp
 * POST /api/auth/whatsapp/verify  { phone, code }  → { firebaseCustomToken } (uid "wa:<digits>")
 *
 * The client then calls FirebaseAuth.signInWithCustomToken and exchanges the resulting ID token at
 * POST /api/sync/auth/exchange. Both routes answer 503 when Firebase (auth_not_configured, or auth_unavailable when the key is set but unusable) or a code provider is not
 * configured. Codes are never logged here; only the mock sender (non-production) prints one.
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../lib/logger.js';
import { FirebaseAuthLike, firebaseUnavailableBody, getFirebaseAuth } from '../lib/firebaseAdmin.js';
import { E164_RE, phoneDigits } from '../services/learnerIdentity.js';
import { CODE_TTL_SECONDS, OtpDb, OtpProvider, RESEND_AFTER_SECONDS, selectOtpProvider } from '../services/whatsappOtp.js';
import { OtpLimits } from '../services/otpLimits.js';

export interface WhatsappAuthDeps {
  otp: () => OtpProvider | null;
  firebase: () => FirebaseAuthLike | null;
  /** Durable abuse caps (per-phone daily limits, lock, global daily cap). */
  limits: OtpLimits;
}

type PhoneRequest = Request & { signInPhone?: string };

const limited = (windowMs: number, max: number, error: string, keyGenerator?: (req: Request) => string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    message: { success: false, error },
  });

export function createWhatsappAuthRouter({ otp, firebase, limits }: WhatsappAuthDeps): Router {
  const router = Router();

  // Neither route does anything (or burns a code) unless sign-in is fully configured.
  const configured = (_req: Request, res: Response, next: NextFunction) => {
    if (!firebase()) {
      res.status(503).json(firebaseUnavailableBody()); // auth_not_configured, or auth_unavailable when the key is set but unusable
      return;
    }
    if (!otp()) {
      res.status(503).json({ success: false, error: 'Sign-in is not available right now' }); // no code provider
      return;
    }
    next();
  };

  const validPhone = (req: PhoneRequest, res: Response, next: NextFunction) => {
    const phone = req.body?.phone;
    if (typeof phone !== 'string' || !E164_RE.test(phone)) {
      res.status(400).json({ success: false, error: 'phone must be in international format, e.g. +919876543210' });
      return;
    }
    req.signInPhone = phone;
    next();
  };

  router.post(
    '/start',
    configured,
    limited(60 * 60_000, 5, 'Too many attempts. Please try again later.'),
    validPhone,
    limited(15 * 60_000, 3, 'Too many codes requested for this number. Please try again later.', (req) => (req as PhoneRequest).signInPhone ?? 'unknown'),
    async (req: PhoneRequest, res: Response) => {
      try {
        void limits.purge();
        const verdict = await limits.claimStart(req.signInPhone!);
        if (verdict === 'global_cap') {
          res.status(503).json({ success: false, error: 'Sign-in is temporarily unavailable. Please try again later.' });
          return;
        }
        if (verdict !== 'ok') {
          // phone_cap and locked look the same from outside
          res.status(429).json({ success: false, error: 'Too many codes requested for this number. Please try again later.' });
          return;
        }
        await otp()!.start(req.signInPhone!);
        // The same answer whether or not the number belongs to a known learner.
        res.json({ success: true, data: { resendAfterSeconds: RESEND_AFTER_SECONDS, expiresInSeconds: CODE_TTL_SECONDS } });
      } catch (err: any) {
        logger.error(`WhatsApp sign-in code could not be sent: ${err?.message}`);
        // The user never got a code, so a provider outage must not eat their daily quota.
        await limits.refundStart(req.signInPhone!);
        res.status(502).json({ success: false, error: 'Could not send the code. Please try again.' });
      }
    },
  );

  router.post(
    '/verify',
    configured,
    limited(60 * 60_000, 30, 'Too many attempts. Please try again later.'),
    validPhone,
    async (req: PhoneRequest, res: Response) => {
      try {
        const code = req.body?.code;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
          res.status(400).json({ success: false, error: 'code must be 6 digits' });
          return;
        }
        const phone = req.signInPhone!;
        if (await limits.isLocked(phone)) {
          res.status(429).json({ success: false, error: 'Too many wrong attempts. Please try again later.' });
          return;
        }
        const result = await otp()!.check(phone, code);
        if (result === 'wrong') await limits.recordWrong(phone);
        if (result === 'locked') {
          res.status(429).json({ success: false, error: 'Too many wrong attempts. Please request a new code.' });
          return;
        }
        if (result !== 'ok') {
          res.status(401).json({ success: false, error: 'Invalid or expired code' }); // same for wrong and expired
          return;
        }
        const firebaseCustomToken = await firebase()!.createCustomToken(`wa:${phoneDigits(phone)}`, { phone });
        res.json({ success: true, data: { firebaseCustomToken } });
      } catch (err: any) {
        logger.error(`WhatsApp sign-in verify failed: ${err?.message}`);
        res.status(500).json({ success: false, error: 'Internal error' });
      }
    },
  );

  return router;
}

/** Production wiring: the real database, Firebase Admin and the configured code provider. */
export function createDefaultWhatsappAuthRouter(): Router {
  let provider: OtpProvider | null | undefined;
  const db: OtpDb = { raw: async (sql: string, params?: any[]) => (await import('@ekatra/database')).db.raw(sql, params) };
  return createWhatsappAuthRouter({
    limits: new OtpLimits(db),
    firebase: getFirebaseAuth,
    otp: () => (provider === undefined ? (provider = selectOtpProvider(db)) : provider),
  });
}
