/**
 * Who a verified Firebase ID token is, for sign-in (exchange) and account deletion alike.
 *
 * A phone identity is the same learner row WhatsApp chats use, and is trusted only from the sign-in
 * provider that can vouch for it: our own custom token (a wa: uid, or the `phone` claim, minted only
 * after a verified WhatsApp code) or Firebase phone auth (`phone_number`). Any other provider (Google,
 * email, anonymous, ...) is a plain app-only user, whatever claims it carries.
 */

import { E164_RE } from './learnerIdentity.js';

export interface FirebaseIdentity {
  uid: string;
  /** E.164 when the token proves a phone number, otherwise null (an app-only "fb:<uid>" user). */
  phone: string | null;
}

/** Returns null for a token that must be rejected (no uid, or a trusted phone that is malformed). */
export function resolveFirebaseIdentity(decoded: Record<string, any>): FirebaseIdentity | null {
  const uid: unknown = decoded?.uid;
  if (typeof uid !== 'string' || !uid) return null;

  const provider: unknown = decoded.firebase?.sign_in_provider;
  let phone: string | null = null;
  let trusted = false;
  if (provider === 'custom') {
    if (uid.startsWith('wa:')) { phone = `+${uid.slice(3)}`; trusted = true; }
    else if (typeof decoded.phone === 'string') { phone = decoded.phone; trusted = true; }
  } else if (provider === 'phone' && typeof decoded.phone_number === 'string') {
    phone = decoded.phone_number;
    trusted = true;
  }
  if (!trusted) return { uid, phone: null };
  return phone && E164_RE.test(phone) ? { uid, phone } : null;
}
