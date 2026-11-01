/** WhatsApp OTP providers: Twilio Verify, own template (hashed codes), mock, and selection. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChallengeOtpProvider, TwilioVerifyProvider, twilioTemplateSender, mockSender, selectOtpProvider, otpHmacSecret,
  CODE_TTL_SECONDS, MAX_CODE_ATTEMPTS,
} from '../whatsappOtp.js';
import { makeAuthDb } from '../../routes/__tests__/fakeAuthDb.js';

const PHONE = '+919876543210';
const SECRET = () => 'unit-test-secret';

function challengeProvider(now: () => number = Date.now) {
  const db = makeAuthDb();
  const sent: { phone: string; code: string }[] = [];
  const provider = new ChallengeOtpProvider('test', db, async (phone, code) => { sent.push({ phone, code }); }, SECRET, now);
  return { db, sent, provider };
}

// ── own codes (template + mock share this) ─────────────────────────────────

test('a sent code is 6 digits, and only a keyed hash is stored', async () => {
  const { db, sent, provider } = challengeProvider();
  await provider.start(PHONE);
  assert.match(sent[0].code, /^\d{6}$/);
  assert.equal(db.challenges.length, 1);
  assert.ok(!JSON.stringify(db.challenges).includes(sent[0].code), 'the plain code must not be stored');
  assert.match(db.challenges[0].code_hash, /^[0-9a-f]{64}$/);
});

test('the right code is accepted once; a replay is rejected', async () => {
  const { sent, provider } = challengeProvider();
  await provider.start(PHONE);
  assert.equal(await provider.check(PHONE, sent[0].code), 'ok');
  assert.equal(await provider.check(PHONE, sent[0].code), 'expired'); // consumed: single use
});

test('a wrong code is rejected, and the right one still works afterwards', async () => {
  const { sent, provider } = challengeProvider();
  await provider.start(PHONE);
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  assert.equal(await provider.check(PHONE, wrong), 'wrong');
  assert.equal(await provider.check(PHONE, sent[0].code), 'ok');
});

test('a code expires after 10 minutes', async () => {
  let t = Date.now();
  const { sent, provider } = challengeProvider(() => t);
  await provider.start(PHONE);
  t += (CODE_TTL_SECONDS - 1) * 1000;
  assert.equal(await provider.check(PHONE, 'x'.repeat(6)), 'wrong'); // still alive (costs an attempt)
  t += 2000;
  assert.equal(await provider.check(PHONE, sent[0].code), 'expired');
});

test('5 wrong attempts lock the code, even for the right code afterwards', async () => {
  const { sent, provider } = challengeProvider();
  await provider.start(PHONE);
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  const results: string[] = [];
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) results.push(await provider.check(PHONE, wrong));
  assert.deepEqual(results, ['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
  assert.equal(await provider.check(PHONE, sent[0].code), 'locked');
});

test('a new code replaces the pending one', async () => {
  const { sent, provider } = challengeProvider();
  await provider.start(PHONE);
  await provider.start(PHONE);
  if (sent[0].code !== sent[1].code) assert.equal(await provider.check(PHONE, sent[0].code), 'wrong');
  assert.equal(await provider.check(PHONE, sent[1].code), 'ok');
});

test('a code cannot be used for a different number', async () => {
  const { sent, provider } = challengeProvider();
  await provider.start(PHONE);
  assert.equal(await provider.check('+919000000001', sent[0].code), 'expired');
});

test('no code is accepted when nothing was requested', async () => {
  assert.equal(await challengeProvider().provider.check(PHONE, '123456'), 'expired');
});

test('starting needs a signing secret', async () => {
  const provider = new ChallengeOtpProvider('t', makeAuthDb(), async () => undefined, () => '');
  await assert.rejects(provider.start(PHONE), /JWT_SECRET/);
});

// ── Twilio Verify ──────────────────────────────────────────────────────────

function verifyWith(responses: { status: number; body?: object }[]) {
  const calls: { url: string; body: URLSearchParams; auth: string }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body), auth: init.headers.Authorization });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { calls, provider: new TwilioVerifyProvider({ accountSid: 'ACx', authToken: 'tok', serviceSid: 'VAsvc' }, fetchImpl) };
}

test('Twilio Verify: start posts a WhatsApp verification, check posts a VerificationCheck', async () => {
  const { calls, provider } = verifyWith([{ status: 201 }, { status: 200, body: { status: 'approved' } }]);
  await provider.start(PHONE);
  assert.equal(calls[0].url, 'https://verify.twilio.com/v2/Services/VAsvc/Verifications');
  assert.equal(calls[0].body.get('Channel'), 'whatsapp');
  assert.equal(calls[0].body.get('To'), PHONE);
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('ACx:tok').toString('base64'));
  assert.equal(await provider.check(PHONE, '123456'), 'ok');
  assert.equal(calls[1].url, 'https://verify.twilio.com/v2/Services/VAsvc/VerificationCheck');
  assert.equal(calls[1].body.get('Code'), '123456');
});

test('Twilio Verify: pending → wrong, 404 → expired, 429 → locked, delivery failure throws', async () => {
  const { provider } = verifyWith([
    { status: 200, body: { status: 'pending' } }, { status: 404 }, { status: 429 }, { status: 400 },
  ]);
  assert.equal(await provider.check(PHONE, '111111'), 'wrong');
  assert.equal(await provider.check(PHONE, '111111'), 'expired');
  assert.equal(await provider.check(PHONE, '111111'), 'locked');
  await assert.rejects(provider.start(PHONE), /start failed/);
});

// ── own template via Twilio Content API ────────────────────────────────────

test('template sender posts ContentSid and ContentVariables {"1": code} from the WhatsApp number', async () => {
  let seen: URLSearchParams | undefined; let url = '';
  const send = twilioTemplateSender(
    { accountSid: 'ACx', authToken: 't', from: '+15550001111', contentSid: 'HXabc' },
    (async (u: any, init: any) => { url = String(u); seen = new URLSearchParams(init.body); return new Response('{}', { status: 201 }); }) as typeof fetch);
  await send(PHONE, '482913');
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/ACx/Messages.json');
  assert.equal(seen!.get('From'), 'whatsapp:+15550001111');
  assert.equal(seen!.get('To'), `whatsapp:${PHONE}`);
  assert.equal(seen!.get('ContentSid'), 'HXabc');
  assert.deepEqual(JSON.parse(seen!.get('ContentVariables')!), { '1': '482913' });
  assert.equal(seen!.get('Body'), null);
});

test('template sender throws when Twilio refuses', async () => {
  const send = twilioTemplateSender({ accountSid: 'a', authToken: 't', from: 'whatsapp:+1555', contentSid: 'HX' },
    (async () => new Response('{}', { status: 400 })) as typeof fetch);
  await assert.rejects(send(PHONE, '123456'), /failed \(400\)/);
});

// ── mock + selection ───────────────────────────────────────────────────────

test('the mock sender refuses to run in production', async () => {
  await assert.rejects(mockSender({ NODE_ENV: 'production' })(PHONE, '123456'), /not available in production/);
  await mockSender({ NODE_ENV: 'development' })(PHONE, '123456');
});

test('provider selection: Verify, then own template, then mock outside production, else none', () => {
  const db = makeAuthDb();
  const twilio = { TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't' };
  assert.equal(selectOtpProvider(db, { ...twilio, TWILIO_VERIFY_SERVICE_SID: 'VA1', TWILIO_OTP_CONTENT_SID: 'HX1', TWILIO_WHATSAPP_NUMBER: '+1' })!.name, 'twilio-verify');
  assert.equal(selectOtpProvider(db, { ...twilio, TWILIO_OTP_CONTENT_SID: 'HX1', TWILIO_WHATSAPP_NUMBER: '+1' })!.name, 'twilio-template');
  assert.equal(selectOtpProvider(db, { NODE_ENV: 'development' })!.name, 'mock');
  assert.equal(selectOtpProvider(db, { NODE_ENV: 'production' }), null);
  // Template ids without Twilio credentials or a sender number are not usable
  assert.equal(selectOtpProvider(db, { NODE_ENV: 'production', TWILIO_OTP_CONTENT_SID: 'HX1' }), null);
});

// ── key separation ─────────────────────────────────────────────────────────

test('the code-hash key is OTP_HMAC_SECRET when set', () => {
  assert.equal(otpHmacSecret({ OTP_HMAC_SECRET: 'dedicated', JWT_SECRET: 'jwt' }), 'dedicated');
});

test('without OTP_HMAC_SECRET the key is HKDF-derived from JWT_SECRET, and is never JWT_SECRET itself', () => {
  const derived = otpHmacSecret({ JWT_SECRET: 'jwt-secret-value' });
  assert.match(derived, /^[0-9a-f]{64}$/);
  assert.notEqual(derived, 'jwt-secret-value');
  assert.equal(otpHmacSecret({ JWT_SECRET: 'jwt-secret-value' }), derived); // deterministic across restarts
  assert.notEqual(otpHmacSecret({ JWT_SECRET: 'another-secret' }), derived);
});

test('no key material at all means no key (starting a code then refuses)', async () => {
  assert.equal(otpHmacSecret({}), '');
});

test('codes hashed with the derived key do not verify under the raw JWT secret', async () => {
  const db = makeAuthDb(); const sent: string[] = [];
  const derived = new ChallengeOtpProvider('t', db, async (_p, c) => { sent.push(c); }, () => otpHmacSecret({ JWT_SECRET: 'jwt-secret-value' }));
  await derived.start(PHONE);
  const rawKey = new ChallengeOtpProvider('t', db, async () => undefined, () => 'jwt-secret-value');
  assert.equal(await rawKey.check(PHONE, sent[0]), 'wrong');
});
