import { initializeApp } from 'firebase/app';
import {
  ConfirmationResult,
  RecaptchaVerifier,
  Auth,
  getAuth,
  signInWithPhoneNumber,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let auth: Auth | null = null;

function getFirebaseAuth(): Auth {
  if (auth) return auth;

  const required = [
    firebaseConfig.apiKey,
    firebaseConfig.authDomain,
    firebaseConfig.projectId,
    firebaseConfig.appId,
  ];

  if (required.some((v) => !v)) {
    throw new Error('Firebase OTP is not configured. Set VITE_FIREBASE_* env vars.');
  }

  const app = initializeApp(firebaseConfig, 'ekatra-learner-auth');
  auth = getAuth(app);
  return auth;
}

let recaptchaVerifier: RecaptchaVerifier | null = null;

export async function sendFirebaseOTP(phoneNumber: string, recaptchaContainerId: string): Promise<ConfirmationResult> {
  const firebaseAuth = getFirebaseAuth();

  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(firebaseAuth, recaptchaContainerId, {
      size: 'normal',
      callback: () => {},
      'expired-callback': () => {
        recaptchaVerifier = null;
      },
    });
    await recaptchaVerifier.render();
  }

  return signInWithPhoneNumber(firebaseAuth, phoneNumber, recaptchaVerifier);
}

export function resetFirebaseRecaptcha(): void {
  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
    recaptchaVerifier = null;
  }
}
