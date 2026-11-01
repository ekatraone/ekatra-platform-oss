/**
 * WhatsApp one-time codes for sign-in, behind one interface with three implementations:
 *
 *  a. Twilio Verify (TWILIO_VERIFY_SERVICE_SID): Twilio generates, sends and checks the code.
 *  b. Our own WhatsApp authentication template (TWILIO_OTP_CONTENT_SID): we generate the code,
 *     send it with ContentSid/ContentVariables, and keep only a keyed hash in otp_challenges.
 *  c. A mock outside production that logs the code (the only place a code is ever logged).
 *
 * Production with none of these configured has no provider, and the routes answer 503.
 */

import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';

export const CODE_TTL_SECONDS = 600;
export const MAX_CODE_ATTEMPTS = 5;
export const RESEND_AFTER_SECONDS = 30;

export type CheckResult = 'ok' | 'wrong' | 'expired' | 'locked';

export interface OtpProvider {
  readonly name: string;
  /** Sends a fresh code to an E.164 number on WhatsApp. Throws when delivery fails. */
  start(phone: string): Promise<void>;
  check(phone: string, code: string): Promise<CheckResult>;
}

export interface OtpDb {
  raw(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

type Env = Record<string, string | undefined>;

/**
 * Key for hashing codes. OTP_HMAC_SECRET when set; otherwise derived from JWT_SECRET with HKDF and
 * a fixed info string, so the code-hash key is never the JWT signing key itself.
 */
export function otpHmacSecret(env: Env = process.env): string {
  if (env.OTP_HMAC_SECRET) return env.OTP_HMAC_SECRET;
  if (!env.JWT_SECRET) return '';
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, '', 'ekatra/otp-code-hmac/v1', 32)).toString('hex');
}

// ── a. Twilio Verify ───────────────────────────────────────────────────────

export class TwilioVerifyProvider implements OtpProvider {
  readonly name = 'twilio-verify';
  constructor(private cfg: { accountSid: string; authToken: string; serviceSid: string }, private fetchImpl: typeof fetch = fetch) {}

  private async post(path: string, params: Record<string, string>) {
    return this.fetchImpl(`https://verify.twilio.com/v2/Services/${this.cfg.serviceSid}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  async start(phone: string): Promise<void> {
    const res = await this.post('Verifications', { To: phone, Channel: 'whatsapp' });
    if (!res.ok) throw new Error(`Twilio Verify start failed (${res.status})`);
  }

  async check(phone: string, code: string): Promise<CheckResult> {
    const res = await this.post('VerificationCheck', { To: phone, Code: code });
    if (res.status === 404) return 'expired'; // no pending verification: expired, consumed or never started
    if (res.status === 429) return 'locked'; // Twilio's own max-attempts / rate limit
    if (!res.ok) throw new Error(`Twilio Verify check failed (${res.status})`);
    const body: any = await res.json();
    return body?.status === 'approved' ? 'ok' : 'wrong';
  }
}

// ── b. Own authentication template + c. mock: our own codes in otp_challenges ──

/** Delivers a code we generated ourselves. */
export type CodeSender = (phone: string, code: string) => Promise<void>;

export class ChallengeOtpProvider implements OtpProvider {
  constructor(
    readonly name: string,
    private db: OtpDb,
    private send: CodeSender,
    private secret: () => string = () => otpHmacSecret(),
    private now: () => number = Date.now,
  ) {}

  /** Keyed hash, bound to the phone, so a stolen table cannot be replayed against another number. */
  private hash(phone: string, code: string): string {
    return createHmac('sha256', this.secret()).update(`${phone}:${code}`).digest('hex');
  }

  async start(phone: string): Promise<void> {
    if (!this.secret()) throw new Error('OTP_HMAC_SECRET or JWT_SECRET is required to hash sign-in codes');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // A new code replaces any pending one for the number.
    await this.db.raw(`UPDATE otp_challenges SET consumed_at = NOW() WHERE phone = $1 AND consumed_at IS NULL`, [phone]);
    await this.db.raw(
      `INSERT INTO otp_challenges (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
      [phone, this.hash(phone, code), new Date(this.now() + CODE_TTL_SECONDS * 1000).toISOString()],
    );
    await this.send(phone, code);
  }

  async check(phone: string, code: string): Promise<CheckResult> {
    const found = await this.db.raw(
      `SELECT id, code_hash, expires_at FROM otp_challenges
       WHERE phone = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const challenge = found.rows[0];
    if (!challenge || new Date(challenge.expires_at).getTime() <= this.now()) return 'expired';

    // Every guess, right or wrong, spends an attempt first; the UPDATE is the atomic gate.
    const spent = await this.db.raw(
      `UPDATE otp_challenges SET attempts = attempts + 1
       WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts`,
      [challenge.id, MAX_CODE_ATTEMPTS],
    );
    if (!spent.rows.length) return 'locked';

    const expected = Buffer.from(challenge.code_hash, 'hex');
    const actual = Buffer.from(this.hash(phone, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return spent.rows[0].attempts >= MAX_CODE_ATTEMPTS ? 'locked' : 'wrong';
    }
    // Single use: only the request that flips consumed_at wins.
    const used = await this.db.raw(
      `UPDATE otp_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [challenge.id],
    );
    return used.rows.length ? 'ok' : 'expired';
  }
}

/** Sends the approved WhatsApp authentication template through Twilio's Content API. */
export function twilioTemplateSender(
  cfg: { accountSid: string; authToken: string; from: string; contentSid: string },
  fetchImpl: typeof fetch = fetch,
): CodeSender {
  return async (phone, code) => {
    const from = cfg.from.startsWith('whatsapp:') ? cfg.from : `whatsapp:${cfg.from}`;
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: from,
        To: `whatsapp:${phone}`,
        ContentSid: cfg.contentSid,
        ContentVariables: JSON.stringify({ '1': code }),
      }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio OTP template send failed (${res.status})`);
  };
}

/** Outside production only: logs the code instead of sending it. */
export function mockSender(env: Env = process.env): CodeSender {
  return async (phone, code) => {
    if (env.NODE_ENV === 'production') throw new Error('The mock OTP sender is not available in production');
    logger.info(`[mock OTP] code for ${phone}: ${code}`);
  };
}

// ── Selection ──────────────────────────────────────────────────────────────

export function selectOtpProvider(db: OtpDb, env: Env = process.env, fetchImpl: typeof fetch = fetch): OtpProvider | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (env.TWILIO_VERIFY_SERVICE_SID && accountSid && authToken) {
    return new TwilioVerifyProvider({ accountSid, authToken, serviceSid: env.TWILIO_VERIFY_SERVICE_SID }, fetchImpl);
  }
  if (env.TWILIO_OTP_CONTENT_SID && env.TWILIO_WHATSAPP_NUMBER && accountSid && authToken) {
    return new ChallengeOtpProvider(
      'twilio-template',
      db,
      twilioTemplateSender({ accountSid, authToken, from: env.TWILIO_WHATSAPP_NUMBER, contentSid: env.TWILIO_OTP_CONTENT_SID }, fetchImpl),
    );
  }
  if (env.NODE_ENV !== 'production') return new ChallengeOtpProvider('mock', db, mockSender(env));
  return null;
}
