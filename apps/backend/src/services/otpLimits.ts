/**
 * Sign-in abuse caps that survive restarts (counted in Postgres) and apply to every code provider,
 * Twilio Verify included:
 *  - at most 10 codes per phone in 24 h
 *  - 20 wrong guesses per phone start a 1 h lock; a second lock within 24 h (20 more wrong guesses
 *    after the first lock) escalates to 24 h
 *  - a global daily cap on code requests (OTP_DAILY_CAP, default 500)
 * Old rows are purged opportunistically when a code is requested.
 */

import { logger } from '../lib/logger.js';
import { OtpDb } from './whatsappOtp.js';

export const MAX_CODES_PER_PHONE_PER_DAY = 10;
export const MAX_WRONG_PER_PHONE_PER_DAY = 20;
export const DEFAULT_DAILY_CAP = 500;

/**
 * SQL for "this phone is locked right now": the latest lock lasts 1 hour, or 24 hours once there
 * are two locks inside the last 24 hours. `$1` is the phone.
 */
const LOCKED_NOW_SQL = `EXISTS (
  SELECT 1 FROM otp_events lk
  WHERE lk.phone = $1 AND lk.kind = 'lock'
    AND lk.created_at > NOW() - (CASE
      WHEN (SELECT COUNT(*) FROM otp_events WHERE phone = $1 AND kind = 'lock' AND created_at > NOW() - INTERVAL '24 hours') >= 2
      THEN INTERVAL '24 hours' ELSE INTERVAL '1 hour' END)
)`;

export type StartVerdict = 'ok' | 'locked' | 'phone_cap' | 'global_cap';

export function dailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.OTP_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

export class OtpLimits {
  constructor(private db: OtpDb, private env: Record<string, string | undefined> = process.env) {}

  async isLocked(phone: string): Promise<boolean> {
    const r = await this.db.raw(`SELECT ${LOCKED_NOW_SQL} AS locked_now`, [phone]);
    return r.rows[0]?.locked_now === true;
  }

  /** Decides whether a code may be requested, and records the request when it may. */
  async claimStart(phone: string): Promise<StartVerdict> {
    const r = await this.db.raw(
      `SELECT
         ${LOCKED_NOW_SQL} AS locked,
         (SELECT COUNT(*)::int FROM otp_events WHERE phone = $1 AND kind = 'start' AND created_at > NOW() - INTERVAL '24 hours') AS phone_starts,
         (SELECT COUNT(*)::int FROM otp_events WHERE kind = 'start' AND created_at > NOW() - INTERVAL '24 hours') AS global_starts`,
      [phone],
    );
    const row = r.rows[0] ?? {};
    if (row.locked) return 'locked';
    if ((row.global_starts ?? 0) >= dailyCap(this.env)) {
      // Deliberately no phone number: this line is meant to be alerted on.
      logger.warn('OTP global daily cap reached: sign-in codes are being refused', { cap: dailyCap(this.env) });
      return 'global_cap';
    }
    if ((row.phone_starts ?? 0) >= MAX_CODES_PER_PHONE_PER_DAY) return 'phone_cap';
    await this.db.raw(`INSERT INTO otp_events (phone, kind) VALUES ($1, 'start')`, [phone]);
    return 'ok';
  }

  /**
   * Records a wrong guess. Wrong guesses are counted since the later of 24 h ago and the last lock, so
   * a lock needs 20 fresh wrong guesses: the first lock lasts 1 h, a second one within 24 h lasts 24 h.
   */
  async recordWrong(phone: string): Promise<void> {
    await this.db.raw(`INSERT INTO otp_events (phone, kind) VALUES ($1, 'wrong')`, [phone]);
    const r = await this.db.raw(
      `SELECT COUNT(*)::int AS n FROM otp_events
       WHERE phone = $1 AND kind = 'wrong'
         AND created_at > GREATEST(
           NOW() - INTERVAL '24 hours',
           COALESCE((SELECT MAX(created_at) FROM otp_events WHERE phone = $1 AND kind = 'lock'), '-infinity'::timestamptz))`,
      [phone],
    );
    if ((r.rows[0]?.n ?? 0) >= MAX_WRONG_PER_PHONE_PER_DAY && !(await this.isLocked(phone))) {
      await this.db.raw(`INSERT INTO otp_events (phone, kind) VALUES ($1, 'lock')`, [phone]);
    }
  }

  /** Gives back the most recent code count for a phone, when the code could not be delivered. */
  async refundStart(phone: string): Promise<void> {
    await this.db.raw(
      `DELETE FROM otp_events WHERE id = (
         SELECT id FROM otp_events WHERE phone = $1 AND kind = 'start' ORDER BY created_at DESC LIMIT 1)`,
      [phone],
    ).catch(() => undefined);
  }

  /** Housekeeping, never fatal: codes older than a day and ledger rows older than two. */
  async purge(): Promise<void> {
    await this.db.raw(`DELETE FROM otp_challenges WHERE created_at < NOW() - INTERVAL '24 hours'`).catch(() => undefined);
    await this.db.raw(`DELETE FROM otp_events WHERE created_at < NOW() - INTERVAL '48 hours'`).catch(() => undefined);
  }
}
