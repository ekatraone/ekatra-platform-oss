/**
 * Every route that answers 503 because FIREBASE_SERVICE_ACCOUNT is not configured returns exactly
 * { success:false, error:"auth_not_configured" }. The app reads that body: on the delete routes it
 * means "nothing to erase". Other 503s keep their own strings.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createSyncRouter } from '../sync.js';
import { createWhatsappAuthRouter } from '../authWhatsapp.js';
import { AUTH_NOT_CONFIGURED, AUTH_UNAVAILABLE, firebaseUnavailableBody, getFirebaseAuth, setFirebaseAuthForTests } from '../../lib/firebaseAdmin.js';
import { OtpLimits } from '../../services/otpLimits.js';
import { ChallengeOtpProvider } from '../../services/whatsappOtp.js';
import { makeAuthDb, makeFirebase } from './fakeAuthDb.js';

let servers: Server[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  setFirebaseAuthForTests(undefined);
  for (const s of servers) s.close();
  servers = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function startApp(opts: { firebase: boolean; otp?: boolean; env?: Record<string, string>; real?: boolean }) {
  process.env.JWT_SECRET = 'secret-for-not-configured-tests';
  setFirebaseAuthForTests(undefined);
  if (!opts.real) delete process.env.FIREBASE_SERVICE_ACCOUNT;
  const db = makeAuthDb();
  const firebase = makeFirebase();
  const otp = new ChallengeOtpProvider('t', db, async () => undefined, () => 'k');
  const app = express();
  app.use(express.json());
  app.use('/api/auth/whatsapp', createWhatsappAuthRouter({
    otp: () => (opts.otp === false ? null : otp),
    firebase: opts.real ? getFirebaseAuth : () => (opts.firebase ? firebase : null),
    limits: new OtpLimits(db, opts.env ?? {}),
  }));
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: 'x' }) }, firebase: opts.real ? getFirebaseAuth : () => (opts.firebase ? firebase : null) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body: object) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { call };
}

const ROUTES: [string, string, object][] = [
  ['POST', '/api/auth/whatsapp/start', { phone: '+919876543210' }],
  ['POST', '/api/auth/whatsapp/verify', { phone: '+919876543210', code: '123456' }],
  ['POST', '/api/sync/auth/exchange', { idToken: '{"uid":"u"}' }],
  ['DELETE', '/api/sync/auth/account', { idToken: '{"uid":"u"}' }],
  ['POST', '/api/sync/auth/account/delete', { idToken: '{"uid":"u"}' }],
];

test('the shared body is exactly { success:false, error:"auth_not_configured" }', () => {
  assert.deepEqual(AUTH_NOT_CONFIGURED, { success: false, error: 'auth_not_configured' });
});

for (const [method, path, body] of ROUTES) {
  test(`${method} ${path}: no Firebase → 503 with exactly auth_not_configured`, async () => {
    const { call } = await startApp({ firebase: false });
    const res = await call(method, path, body);
    assert.equal(res.status, 503);
    assert.equal(await res.text(), JSON.stringify({ success: false, error: 'auth_not_configured' }));
  });
}

test('with Firebase configured none of these routes answer auth_not_configured', async () => {
  const { call } = await startApp({ firebase: true });
  for (const [method, path, body] of ROUTES) {
    const res = await call(method, path, body);
    assert.notEqual(((await res.json()) as any).error, 'auth_not_configured', `${method} ${path}`);
  }
});

test('other 503s keep their own strings: a missing code provider, and the OTP daily cap', async () => {
  const noProvider = await startApp({ firebase: true, otp: false });
  const missing = await noProvider.call('POST', '/api/auth/whatsapp/start', { phone: '+919876543210' });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { success: false, error: 'Sign-in is not available right now' });

  const capped = await startApp({ firebase: true, env: { OTP_DAILY_CAP: '1' } });
  await capped.call('POST', '/api/auth/whatsapp/start', { phone: '+919000000001' });
  const over = await capped.call('POST', '/api/auth/whatsapp/start', { phone: '+919000000002' });
  assert.equal(over.status, 503);
  const body: any = await over.json();
  assert.notEqual(body.error, 'auth_not_configured');
  assert.match(body.error, /temporarily unavailable/);
});

test('a missing JWT_SECRET on the exchange keeps its own 503 string', async () => {
  const { call } = await startApp({ firebase: true });
  delete process.env.JWT_SECRET;
  const res = await call('POST', '/api/sync/auth/exchange', { idToken: '{"uid":"u"}' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { success: false, error: 'Sign-in is not available right now' });
});

// ── absent/empty vs set-but-unusable, through the real lazy Firebase lookup ──

const b64 = (s: string) => Buffer.from(s).toString('base64');

const ABSENT: [string, string | undefined][] = [['unset', undefined], ['empty', ''], ['only whitespace', '   ']];
const UNUSABLE: [string, string][] = [
  ['invalid base64', 'not-base64!!'],
  ['base64 that is not JSON', b64('definitely not json')],
  ['raw JSON that is broken', '{"type": "service_account", '],
  ['valid JSON that is not a service account', b64('{"hello":"world"}')],
  ['a service account with no private key', b64(JSON.stringify({ type: 'service_account', project_id: 'maya-ai-ekatra', client_email: 'x@y.iam.gserviceaccount.com' }))],
];

for (const [label, value] of ABSENT) {
  test(`FIREBASE_SERVICE_ACCOUNT ${label}: every route answers auth_not_configured`, async () => {
    const { call } = await startApp({ firebase: false, real: true });
    if (value === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = value;
    setFirebaseAuthForTests(undefined);
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body);
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(await res.text(), JSON.stringify({ success: false, error: 'auth_not_configured' }), `${method} ${path}`);
    }
  });
}

for (const [label, value] of UNUSABLE) {
  test(`FIREBASE_SERVICE_ACCOUNT set but unusable (${label}): every route answers auth_unavailable`, async () => {
    const { call } = await startApp({ firebase: false, real: true });
    process.env.FIREBASE_SERVICE_ACCOUNT = value;
    setFirebaseAuthForTests(undefined);
    assert.equal(getFirebaseAuth(), null, 'the value must not yield a usable Firebase Auth');
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body);
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(await res.text(), JSON.stringify({ success: false, error: 'auth_unavailable' }), `${method} ${path}`);
    }
  });
}

test('the two bodies are distinct constants, and only an absent or blank variable means "not configured"', () => {
  assert.deepEqual(AUTH_UNAVAILABLE, { success: false, error: 'auth_unavailable' });
  assert.notDeepEqual(AUTH_UNAVAILABLE, AUTH_NOT_CONFIGURED);
  assert.equal(firebaseUnavailableBody({}), AUTH_NOT_CONFIGURED);
  assert.equal(firebaseUnavailableBody({ FIREBASE_SERVICE_ACCOUNT: '' }), AUTH_NOT_CONFIGURED);
  assert.equal(firebaseUnavailableBody({ FIREBASE_SERVICE_ACCOUNT: '  \n ' }), AUTH_NOT_CONFIGURED);
  assert.equal(firebaseUnavailableBody({ FIREBASE_SERVICE_ACCOUNT: 'x' }), AUTH_UNAVAILABLE);
});

test('an unusable key does not leak into the response bodies', async () => {
  const secret = 'SUPERSECRETKEYTEXT';
  const { call } = await startApp({ firebase: false, real: true });
  process.env.FIREBASE_SERVICE_ACCOUNT = b64(JSON.stringify({ private_key: secret }));
  setFirebaseAuthForTests(undefined);
  for (const [method, path, body] of ROUTES) {
    assert.ok(!(await (await call(method, path, body)).text()).includes(secret));
  }
});
