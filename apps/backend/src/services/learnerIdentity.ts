/**
 * Find-or-create a learner by phone, shared by the tester sign-in route and issueDemoLearner.
 *
 * The WhatsApp flow stores the sender's number as bare digits (the Cloud API / Twilio `WaId`,
 * e.g. 919900000050) with whatsapp_id set to the same value, and its lookup accepts either
 * "+<digits>" or "<digits>". This matches that exactly, so an app tester and the same person
 * on WhatsApp are one learner row, never two profiles.
 */

import jwt from 'jsonwebtoken';

export interface IdentityDb {
  raw(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export const E164_RE = /^\+[1-9]\d{7,14}$/;
export const MAX_NAME_LENGTH = 60;

export const phoneDigits = (phone: string) => phone.replace(/\D/g, '');

export interface LearnerRecord {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
  email?: string | null;
}

export async function defaultOrganizationId(db: IdentityDb): Promise<string | null> {
  const found = await db.raw(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  return found.rows[0]?.id ?? null;
}

/** Looks a learner up by phone without ever creating one. Matches either stored format or whatsapp_id. */
export async function findLearnerByPhone(db: IdentityDb, phone: string, organizationId?: string): Promise<LearnerRecord | null> {
  const org = organizationId ?? (await defaultOrganizationId(db));
  if (!org) return null;
  const digits = phoneDigits(phone);
  const found = await db.raw(
    `SELECT id, organization_id, phone, name, email FROM learners
     WHERE organization_id = $1 AND (phone = $2 OR phone = $3 OR whatsapp_id = $3)
     ORDER BY created_at ASC LIMIT 1`,
    [org, `+${digits}`, digits],
  );
  return (found.rows[0] as LearnerRecord | undefined) ?? null;
}

/** Looks up the app-only "fb:<uid>" learner without ever creating one. */
export async function findLearnerByFirebaseUid(db: IdentityDb, uid: string, organizationId?: string): Promise<LearnerRecord | null> {
  const org = organizationId ?? (await defaultOrganizationId(db));
  if (!org) return null;
  const found = await db.raw(
    `SELECT id, organization_id, phone, name, email FROM learners WHERE organization_id = $1 AND phone = $2 LIMIT 1`,
    [org, firebaseAddress(uid)],
  );
  return (found.rows[0] as LearnerRecord | undefined) ?? null;
}

/**
 * `phone` must already be E.164 (`+<digits>`). Existing rows are matched by either stored
 * format (or whatsapp_id) within the default organization; new rows are written the way the
 * WhatsApp flow writes them.
 */
export async function findOrCreateLearnerByPhone(
  db: IdentityDb,
  input: { phone: string; name?: string | null; organizationId?: string; timezone?: string },
): Promise<{ learner: LearnerRecord; created: boolean } | null> {
  const organizationId = input.organizationId ?? (await defaultOrganizationId(db));
  if (!organizationId) return null;
  const digits = phoneDigits(input.phone);

  const find = async () =>
    (
      await db.raw(
        `SELECT id, organization_id, phone, name, email FROM learners
         WHERE organization_id = $1 AND (phone = $2 OR phone = $3 OR whatsapp_id = $3)
         ORDER BY created_at ASC LIMIT 1`,
        [organizationId, `+${digits}`, digits],
      )
    ).rows[0] as LearnerRecord | undefined;

  const existing = await find();
  if (existing) return { learner: existing, created: false };

  const inserted = await db.raw(
    `INSERT INTO learners (organization_id, phone, whatsapp_id, name, language, timezone)
     VALUES ($1, $2, $2, $3, 'en', $4)
     ON CONFLICT (organization_id, phone) DO NOTHING
     RETURNING id, organization_id, phone, name, email`,
    [organizationId, digits, input.name?.trim() || 'Friend', input.timezone ?? 'Asia/Kolkata'],
  );
  if (inserted.rows[0]) return { learner: inserted.rows[0], created: true };

  // Lost a race with a concurrent insert (e.g. the WhatsApp flow): use that row.
  const raced = await find();
  return raced ? { learner: raced, created: false } : null;
}

/** Channel address of a learner who signed in only through the app (Google/email via Firebase). */
export const firebaseAddress = (uid: string) => `fb:${uid}`;

/**
 * Find-or-create the learner for a Firebase user without a phone number. Like "tg:<chat_id>" for
 * Telegram, the phone column holds the channel address "fb:<uid>"; nothing is ever sent to it.
 */
export async function findOrCreateLearnerByFirebaseUid(
  db: IdentityDb,
  input: { uid: string; name?: string | null; email?: string | null; organizationId?: string; timezone?: string },
): Promise<{ learner: LearnerRecord; created: boolean } | null> {
  const organizationId = input.organizationId ?? (await defaultOrganizationId(db));
  if (!organizationId) return null;
  const address = firebaseAddress(input.uid);
  const email = input.email?.trim().slice(0, 255) || null;
  const name = (input.name?.trim() || email?.split('@')[0] || 'Friend').slice(0, MAX_NAME_LENGTH);

  const find = async () =>
    (
      await db.raw(
        `SELECT id, organization_id, phone, name, email FROM learners WHERE organization_id = $1 AND phone = $2 LIMIT 1`,
        [organizationId, address],
      )
    ).rows[0] as LearnerRecord | undefined;

  const existing = await find();
  if (existing) {
    // Fill in an email learned later; never overwrite what the learner already has.
    if (email && !existing.email) {
      await db.raw(`UPDATE learners SET email = $2, updated_at = NOW() WHERE id = $1 AND email IS NULL`, [existing.id, email]);
      existing.email = email;
    }
    return { learner: existing, created: false };
  }

  const inserted = await db.raw(
    `INSERT INTO learners (organization_id, phone, name, email, language, timezone)
     VALUES ($1, $2, $3, $4, 'en', $5)
     ON CONFLICT (organization_id, phone) DO NOTHING
     RETURNING id, organization_id, phone, name, email`,
    [organizationId, address, name, email, input.timezone ?? 'Asia/Kolkata'],
  );
  if (inserted.rows[0]) return { learner: inserted.rows[0], created: true };
  const raced = await find();
  return raced ? { learner: raced, created: false } : null;
}

/** A 30-day learner JWT in the format learner auth accepts: { learnerId, phone, role, organizationId }. */
export function signLearnerToken(learner: LearnerRecord, secret: string): string {
  return jwt.sign(
    { learnerId: learner.id, phone: learner.phone, role: 'learner', organizationId: learner.organization_id },
    secret,
    { algorithm: 'HS256', expiresIn: '30d' },
  );
}
