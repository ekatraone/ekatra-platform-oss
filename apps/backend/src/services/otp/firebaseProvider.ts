import admin from 'firebase-admin';
import { OTPProvider, OTPVerifyInput, OTPVerifyResult } from './types.js';

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  return `+${trimmed.replace(/\D/g, '')}`;
}

let firebaseReady = false;

function ensureFirebaseAdminInitialized() {
  if (firebaseReady) return;

  if (admin.apps.length > 0) {
    firebaseReady = true;
    return;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    const creds = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
      projectId: process.env.FIREBASE_PROJECT_ID || creds.project_id,
    });
    firebaseReady = true;
    return;
  }

  // Falls back to ADC/GOOGLE_APPLICATION_CREDENTIALS when running in cloud.
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  firebaseReady = true;
}

export class FirebaseOTPProvider implements OTPProvider {
  readonly name = 'firebase';

  async verify(input: OTPVerifyInput): Promise<OTPVerifyResult> {
    ensureFirebaseAdminInitialized();

    const decoded = await admin.auth().verifyIdToken(input.idToken, true);
    const tokenPhone = decoded.phone_number;

    if (!tokenPhone) {
      throw new Error('Firebase token does not include phone_number');
    }

    if (input.phoneNumber) {
      const expected = normalizePhone(input.phoneNumber);
      const actual = normalizePhone(tokenPhone);
      if (expected !== actual) {
        throw new Error('Phone number mismatch for OTP verification');
      }
    }

    return {
      provider: this.name,
      phoneNumber: normalizePhone(tokenPhone),
      providerUserId: decoded.uid,
    };
  }
}
