import { FirebaseOTPProvider } from './firebaseProvider.js';
import { MockOTPProvider } from './mockProvider.js';
import { OTPProvider, OTPVerifyInput, OTPVerifyResult } from './types.js';

const providers = new Map<string, OTPProvider>();
providers.set('firebase', new FirebaseOTPProvider());
providers.set('mock', new MockOTPProvider());

function normalizeProvider(provider?: string): string {
  const fromInput = provider?.trim().toLowerCase();
  if (fromInput) return fromInput;
  return (process.env.OTP_PROVIDER || 'firebase').trim().toLowerCase();
}

function getProvider(provider?: string): OTPProvider {
  const selected = normalizeProvider(provider);
  const impl = providers.get(selected);
  if (!impl) {
    throw new Error(`Unsupported OTP provider: ${selected}`);
  }
  return impl;
}

export async function verifyOTPToken(input: OTPVerifyInput): Promise<OTPVerifyResult> {
  const impl = getProvider(input.provider);
  return impl.verify(input);
}

export function listOTPProviders(): string[] {
  return Array.from(providers.keys());
}
