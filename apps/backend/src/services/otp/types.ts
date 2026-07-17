export interface OTPVerifyInput {
  provider: string;
  idToken: string;
  phoneNumber?: string;
}

export interface OTPVerifyResult {
  provider: string;
  phoneNumber: string;
  providerUserId?: string;
}

export interface OTPProvider {
  readonly name: string;
  verify(input: OTPVerifyInput): Promise<OTPVerifyResult>;
}
