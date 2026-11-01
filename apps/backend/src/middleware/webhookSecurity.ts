import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { selectedProvider } from '@ekatra/delivery/configuration';

declare global {
  namespace Express {
    interface Request { rawBody?: Buffer; }
  }
}

export function verifyMetaSignature(rawBody: Buffer | undefined, signature: unknown, secret: string | undefined): boolean {
  if (!rawBody || !secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  return timingSafeEqual(expected, actual);
}

export function verifySharedSecret(actual: unknown, expected: string | undefined): boolean {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireWebhookProvider(provider: 'cloudapi' | 'twilio') {
  return (_req: Request, res: Response, next: NextFunction): void => {
    try {
      if (selectedProvider(process.env) === provider) { next(); return; }
    } catch { /* Invalid configuration cannot enable ingress. */ }
    res.sendStatus(404);
  };
}
