import { OTPProvider, OTPVerifyInput, OTPVerifyResult } from './types.js';

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  return `+${trimmed.replace(/\D/g, '')}`;
}

function parseMockPhone(input: OTPVerifyInput): string {
  if (input.phoneNumber) return normalizePhone(input.phoneNumber);

  // Accept idToken format: mock:+919999999999 or mock:919999999999
  const raw = String(input.idToken || '').trim();
  if (!raw.toLowerCase().startsWith('mock:')) {
    throw new Error('Mock OTP idToken must be in format mock:+<phone>');
  }

  const phonePart = raw.slice(5);
  if (!phonePart) {
    throw new Error('Mock OTP idToken missing phone number');
  }
  return normalizePhone(phonePart);
}

export class MockOTPProvider implements OTPProvider {
  readonly name = 'mock';

  async verify(input: OTPVerifyInput): Promise<OTPVerifyResult> {
    const phone = parseMockPhone(input);
    if (phone.length < 8) {
      throw new Error('Invalid phone number for mock OTP');
    }

    return {
      provider: this.name,
      phoneNumber: phone,
      providerUserId: `mock_${phone.replace(/\D/g, '')}`,
    };
  }
}
