/** POST /api/auth/whatsapp/start and /verify — real router, stub Firebase, real OTP logic over a fake table. */

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createWhatsappAuthRouter } from '../authWhatsapp.js';
import { ChallengeOtpProvider, OtpProvider } from '../../services/whatsappOtp.js';
import { OtpLimits } from '../../services/otpLimits.js';
import { makeAuthDb, makeFirebase } from './fakeAuthDb.js';

const PHONE = '+919876543210';
let servers: Server[] = [];
const savedEnv = { ...process.env };
beforeEach(() => { process.env.JWT_SECRET = 'secret-for-otp-tests'; });
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function startApp(opts: { firebase?: boolean; otp?: boolean; now?: () => number; env?: Record<string, string> } = {}) {
  const db = makeAuthDb();
  const sent: { phone: string; code: string }[] = [];
  const firebase = makeFirebase();
  const provider: OtpProvider = new ChallengeOtpProvider('test', db, async (phone, code) => { sent.push({ phone, code }); }, () => process.env.JWT_SECRET!, opts.now);
  const app = express();
  app.use(express.json());
  app.use('/api/auth/whatsapp', createWhatsappAuthRouter({
    otp: () => (opts.otp === false ? null : provider),
    firebase: () => (opts.firebase === false ? null : firebase),
    limits: new OtpLimits(db, opts.env ?? {}),
  }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/whatsapp`;
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { db, sent, firebase, post };
}

// ── start ──────────────────────────────────────────────────────────────────

test('start: sends a code and answers with the fixed shape', async () => {
  const { post, sent } = await startApp();
  const res = await post('/start', { phone: PHONE });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, data: { resendAfterSeconds: 30, expiresInSeconds: 600 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, PHONE);
});

test('start: the response is identical for a known and an unknown number', async () => {
  const { post, db } = await startApp();
  db.learners.push({ id: '00000000-0000-4000-8000-0000000000c1', organization_id: 'o', phone: '919876543210', whatsapp_id: '919876543210', name: 'Known', email: null, created_at: 0 });
  const known = await (await post('/start', { phone: PHONE })).json();
  const unknown = await (await post('/start', { phone: '+919000000001' })).json();
  assert.deepEqual(known, unknown);
});

test('start: a bad phone is 400', async () => {
  const { post, sent } = await startApp();
  for (const phone of ['9876543210', '+0123', '+91 98765', undefined, 5]) {
    assert.equal((await post('/start', { phone })).status, 400, String(phone));
  }
  assert.equal(sent.length, 0);
});

test('start: 3 codes per phone per 15 minutes, then 429 (other numbers unaffected)', async () => {
  const { post, sent } = await startApp();
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('/start', { phone: PHONE })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(sent.length, 3);
  assert.equal((await post('/start', { phone: '+919000000001' })).status, 200);
});

test('start: 5 requests per IP per hour, then 429', async () => {
  const { post } = await startApp();
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await post('/start', { phone: `+9190000000${10 + i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
});

test('start: 503 when Firebase or the code provider is not configured, and nothing is sent', async () => {
  for (const opts of [{ firebase: false }, { otp: false }]) {
    const { post, sent } = await startApp(opts);
    assert.equal((await post('/start', { phone: PHONE })).status, 503);
    assert.equal((await post('/verify', { phone: PHONE, code: '123456' })).status, 503);
    assert.equal(sent.length, 0);
  }
});

test('start: a delivery failure is a 502 that does not leak whether the number is known', async () => {
  const app = express();
  app.use(express.json());
  const failing: OtpProvider = { name: 'f', start: async () => { throw new Error('twilio down'); }, check: async () => 'wrong' };
  app.use('/w', createWhatsappAuthRouter({ otp: () => failing, firebase: () => makeFirebase(), limits: new OtpLimits(makeAuthDb(), {}) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/w/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE }) });
  assert.equal(res.status, 502);
});

// ── verify ─────────────────────────────────────────────────────────────────

test('verify: the right code returns a Firebase custom token for uid wa:<digits> with a phone claim', async () => {
  const { post, sent, firebase } = await startApp();
  await post('/start', { phone: PHONE });
  const res = await post('/verify', { phone: PHONE, code: sent[0].code });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, data: { firebaseCustomToken: 'custom-token-for:wa:919876543210' } });
  assert.deepEqual(firebase.calls.custom, [{ uid: 'wa:919876543210', claims: { phone: PHONE } }]);
});

test('verify: a wrong code is a generic 401, the same body as an expired one', async () => {
  let t = Date.now();
  const { post, sent } = await startApp({ now: () => t });
  await post('/start', { phone: PHONE });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  const wrongRes = await post('/verify', { phone: PHONE, code: wrong });
  assert.equal(wrongRes.status, 401);
  t += 11 * 60_000;
  const expiredRes = await post('/verify', { phone: PHONE, code: sent[0].code });
  assert.equal(expiredRes.status, 401);
  assert.deepEqual(await wrongRes.json(), await expiredRes.json());
});

test('verify: 5 wrong attempts lock the code with a 429, even for the correct code', async () => {
  const { post, sent } = await startApp();
  await post('/start', { phone: PHONE });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await post('/verify', { phone: PHONE, code: wrong })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  assert.equal((await post('/verify', { phone: PHONE, code: sent[0].code })).status, 429);
});

test('verify: a malformed code or phone is a 400 and does not spend an attempt', async () => {
  const { post, sent, db } = await startApp();
  await post('/start', { phone: PHONE });
  for (const code of ['12345', '1234567', 'abcdef', '12 456', 123456, undefined]) {
    assert.equal((await post('/verify', { phone: PHONE, code })).status, 400, String(code));
  }
  assert.equal((await post('/verify', { phone: 'nope', code: '123456' })).status, 400);
  assert.equal(db.challenges[0].attempts, 0);
  assert.equal((await post('/verify', { phone: PHONE, code: sent[0].code })).status, 200);
});

test('verify: a code is single-use', async () => {
  const { post, sent } = await startApp();
  await post('/start', { phone: PHONE });
  assert.equal((await post('/verify', { phone: PHONE, code: sent[0].code })).status, 200);
  assert.equal((await post('/verify', { phone: PHONE, code: sent[0].code })).status, 401);
});

test('codes are never written to the log in production', async () => {
  const { logger } = await import('../../lib/logger.js');
  const lines: string[] = [];
  const spy = (orig: any) => (...a: any[]) => { lines.push(a.join(' ')); return orig?.apply(logger, a); };
  const origInfo = (logger as any).info, origWarn = (logger as any).warn, origError = (logger as any).error;
  (logger as any).info = spy(origInfo); (logger as any).warn = spy(origWarn); (logger as any).error = spy(origError);
  process.env.NODE_ENV = 'production';
  try {
    const { post, sent } = await startApp();
    await post('/start', { phone: PHONE });
    await post('/verify', { phone: PHONE, code: sent[0].code });
    assert.ok(sent[0].code.length === 6);
    assert.ok(!lines.some((l) => l.includes(sent[0].code)), 'no log line may contain the code');
  } finally {
    (logger as any).info = origInfo; (logger as any).warn = origWarn; (logger as any).error = origError;
  }
});

// ── durable abuse caps ─────────────────────────────────────────────────────

test('start: a provider failure (502) refunds the code count, so an outage does not burn the quota', async () => {
  const db = makeAuthDb();
  let fail = true;
  const flaky: OtpProvider = { name: 'f', start: async () => { if (fail) throw new Error('twilio 503'); }, check: async () => 'wrong' };
  const app = express();
  app.use(express.json());
  app.use('/w', createWhatsappAuthRouter({ otp: () => flaky, firebase: () => makeFirebase(), limits: new OtpLimits(db, { OTP_DAILY_CAP: '1' }) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const post = (phone: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/w/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });

  assert.equal((await post(PHONE)).status, 502);
  assert.equal(db.events.filter((e) => e.kind === 'start').length, 0, 'the failed code was refunded');
  fail = false;
  // with a global cap of 1, a burned quota would make this a 503
  assert.equal((await post(PHONE)).status, 200);
  assert.equal(db.events.filter((e) => e.kind === 'start').length, 1, 'a delivered code still counts');
});

test('start: a global daily cap (OTP_DAILY_CAP) answers 503 "temporarily unavailable" and sends nothing more', async () => {
  const { post, sent } = await startApp({ env: { OTP_DAILY_CAP: '2' } });
  assert.equal((await post('/start', { phone: '+919000000001' })).status, 200);
  assert.equal((await post('/start', { phone: '+919000000002' })).status, 200);
  const capped = await post('/start', { phone: '+919000000003' });
  assert.equal(capped.status, 503);
  assert.match(((await capped.json()) as any).error, /temporarily unavailable/);
  assert.equal(sent.length, 2);
});

test('start and verify: a phone under a 24 h lock gets 429 on both, even with the right code', async () => {
  const { post, sent, db } = await startApp();
  await post('/start', { phone: PHONE });
  db.events.push({ phone: PHONE, kind: 'lock', at: Date.now() });
  assert.equal((await post('/start', { phone: PHONE })).status, 429);
  assert.equal((await post('/verify', { phone: PHONE, code: sent[0].code })).status, 429);
  assert.equal(db.challenges[0].attempts, 0); // the lock short-circuits before the code is even checked
});

test('verify: wrong guesses are recorded in the ledger (and only wrong ones)', async () => {
  const { post, sent, db } = await startApp();
  await post('/start', { phone: PHONE });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  await post('/verify', { phone: PHONE, code: wrong });
  await post('/verify', { phone: PHONE, code: wrong });
  await post('/verify', { phone: PHONE, code: sent[0].code });
  assert.deepEqual(db.events.map((e) => e.kind), ['start', 'wrong', 'wrong']);
});

test('the caps also apply on the Twilio Verify path (the ledger is provider-independent)', async () => {
  const db = makeAuthDb();
  let started = 0;
  const verifyLike: OtpProvider = { name: 'twilio-verify', start: async () => { started++; }, check: async () => 'wrong' };
  const app = express();
  app.use(express.json());
  app.use('/w', createWhatsappAuthRouter({ otp: () => verifyLike, firebase: () => makeFirebase(), limits: new OtpLimits(db, { OTP_DAILY_CAP: '1' }) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/w`;
  const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/start', { phone: PHONE })).status, 200);
  assert.equal((await post('/start', { phone: '+919000000009' })).status, 503);
  assert.equal(started, 1);
  await post('/verify', { phone: PHONE, code: '123456' });
  assert.equal(db.events.filter((e) => e.kind === 'wrong').length, 1);
});

test('start purges stale sign-in rows opportunistically', async () => {
  let t = Date.now();
  const db = makeAuthDb([], () => t);
  db.challenges.push({ id: 'old', phone: PHONE, code_hash: 'x', expires_at: new Date(t).toISOString(), attempts: 0, consumed_at: null, created_at: 1, at: t });
  db.events.push({ phone: PHONE, kind: 'start', at: t });
  t += 3 * 24 * 60 * 60 * 1000;
  const app = express();
  app.use(express.json());
  const provider = new ChallengeOtpProvider('t', db, async () => undefined, () => 'k', () => t);
  app.use('/w', createWhatsappAuthRouter({ otp: () => provider, firebase: () => makeFirebase(), limits: new OtpLimits(db, {}) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/w/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+919000000004' }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!db.challenges.some((c) => c.id === 'old'), 'the day-old challenge is gone');
  assert.ok(!db.events.some((e) => e.phone === PHONE), 'the old ledger rows are gone');
  assert.ok(db.challenges.some((c) => c.phone === '+919000000004'), 'the new challenge remains');
});
