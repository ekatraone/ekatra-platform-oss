/** DELETE /api/sync/me — account deletion; the token stops working afterwards. */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createSyncRouter } from '../sync.js';
import { signLearnerToken } from '../../services/learnerIdentity.js';
import { ORG, makeAuthDb, makeFirebase } from './fakeAuthDb.js';

const SECRET = 'secret-for-delete-tests';
let servers: Server[] = [];
const savedEnv = { ...process.env };
beforeEach(() => { process.env.JWT_SECRET = SECRET; });
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function startApp(seed: Parameters<typeof makeAuthDb>[0], withFirebase = true) {
  const db = makeAuthDb(seed);
  const firebase = makeFirebase();
  const app = express();
  app.use(express.json());
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: 'x' }) }, firebase: () => (withFirebase ? firebase : null) }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sync`;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const deleteAccount = (claims: object | string) =>
    fetch(`${base}/auth/account`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: typeof claims === 'string' ? claims : JSON.stringify(claims) }) });
  return { db, base, as, firebase, deleteAccount };
}

const tokenFor = (l: { id: string; phone: string }) =>
  signLearnerToken({ id: l.id, organization_id: ORG, phone: l.phone, name: null }, SECRET);

test('delete: removes the account, and the same token then gets 401 on /me', async () => {
  const { db, base, as } = await startApp([
    { phone: '919876543210', whatsapp_id: '919876543210', name: 'Asha' },
    { phone: '919000000001', whatsapp_id: '919000000001', name: 'Other' },
  ]);
  const token = tokenFor(db.learners[0]);
  assert.equal((await fetch(`${base}/me`, { headers: as(token) })).status, 200);

  const del = await fetch(`${base}/me`, { method: 'DELETE', headers: as(token) });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { success: true });

  assert.equal((await fetch(`${base}/me`, { headers: as(token) })).status, 401);
  assert.equal(db.learners.length, 1);
  assert.equal(db.learners[0].name, 'Other'); // another learner is untouched
});

test('delete: also clears the number\'s sign-in codes and ledger, but not other numbers\'', async () => {
  const { db, base, as } = await startApp([{ phone: '919876543210', whatsapp_id: '919876543210', name: 'Asha' }]);
  const at = Date.now();
  db.challenges.push(
    { id: 'a', phone: '+919876543210', code_hash: 'h', expires_at: new Date(at + 1000).toISOString(), attempts: 0, consumed_at: null, created_at: 1, at },
    { id: 'b', phone: '+919000000009', code_hash: 'h', expires_at: new Date(at + 1000).toISOString(), attempts: 0, consumed_at: null, created_at: 2, at });
  db.events.push({ phone: '+919876543210', kind: 'start', at }, { phone: '+919000000009', kind: 'start', at });
  const res = await fetch(`${base}/me`, { method: 'DELETE', headers: as(tokenFor(db.learners[0])) });
  assert.equal(res.status, 200);
  assert.deepEqual(db.challenges.map((c) => c.id), ['b']);
  assert.deepEqual(db.events.map((e) => e.phone), ['+919000000009']);
});

test('delete: an app-only (fb:) learner can delete too', async () => {
  const { db, base, as } = await startApp([{ phone: 'fb:AbC123', name: 'Mira', email: 'mira@example.com' }]);
  const token = tokenFor(db.learners[0]);
  assert.equal((await fetch(`${base}/me`, { method: 'DELETE', headers: as(token) })).status, 200);
  assert.equal(db.learners.length, 0);
  assert.equal((await fetch(`${base}/me`, { headers: as(token) })).status, 401);
});

test('delete: needs a valid learner token', async () => {
  const { base } = await startApp([{ phone: '919876543210', name: 'Asha' }]);
  assert.equal((await fetch(`${base}/me`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${base}/me`, { method: 'DELETE', headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('delete: runs as ONE statement, so it is all-or-nothing', async () => {
  const { db, base, as } = await startApp([{ phone: '919876543210', name: 'Asha' }]);
  const seen: string[] = [];
  const raw = db.raw.bind(db);
  db.raw = async (sql: string, p?: any[]) => { if (/DELETE FROM learners/.test(sql)) seen.push(sql); return raw(sql, p); };
  await fetch(`${base}/me`, { method: 'DELETE', headers: as(tokenFor(db.learners[0])) });
  assert.equal(seen.length, 1);
  for (const table of ['otp_challenges', 'otp_events', 'message_log', 'failed_messages', 'learners']) {
    assert.match(seen[0], new RegExp(`DELETE FROM ${table}`), table);
  }
});

test('delete: removes courses generated FOR this learner that nobody else took; everything else stays', async () => {
  const { db, base, as } = await startApp([
    { phone: '919876543210', whatsapp_id: '919876543210', name: 'Asha' },
    { phone: '919000000001', whatsapp_id: '919000000001', name: 'Other' },
  ]);
  const [asha, other] = db.learners;
  const course = (id: string, settings: object = {}, over: object = {}) =>
    ({ id, title: id, source: 'ai_generated', fsm_definition_id: null, settings: { aiGenerated: true, ...settings }, ...over });
  db.courses.push(
    course('admin-ai'),                                                        // admin-generated, Asha is its only learner
    course('admin-generator', { generator: { provider: 'meta', model: 'm' } }),  // same, stamped with a generator
    course('requested-solo', { requestedByLearnerId: asha.id }),               // generated for Asha, only she took it
    course('requested-shared', { requestedByLearnerId: asha.id }),             // generated for Asha, Other took it too
    course('requested-by-other', { requestedByLearnerId: other.id }),          // generated for Other; Asha joined it
    course('requested-authored', { requestedByLearnerId: asha.id }, { source: 'authored' }),
    course('requested-fsm', { requestedByLearnerId: asha.id }, { fsm_definition_id: 'f1' }),
    course('requested-nobody-enrolled', { requestedByLearnerId: asha.id }),    // stamped, no enrollment left
    course('legacy-linked'),                                                   // made before the stamp existed
  );
  for (const id of ['admin-ai', 'admin-generator', 'requested-solo', 'requested-shared', 'requested-by-other',
    'requested-authored', 'requested-fsm', 'legacy-linked']) db.enrollments.push({ learner_id: asha.id, course_id: id });
  db.enrollments.push({ learner_id: other.id, course_id: 'requested-shared' }, { learner_id: other.id, course_id: 'requested-by-other' });
  db.syncRequests.push({ learner_id: asha.id, course_id: 'legacy-linked' });

  assert.equal((await fetch(`${base}/me`, { method: 'DELETE', headers: as(tokenFor(asha)) })).status, 200);
  assert.deepEqual(db.courses.map((c) => c.id).sort(),
    ['admin-ai', 'admin-generator', 'requested-authored', 'requested-by-other', 'requested-fsm', 'requested-shared']);
  assert.deepEqual(db.enrollments.map((e) => `${e.learner_id === other.id ? 'other' : 'asha'}:${e.course_id}`).sort(),
    ['other:requested-by-other', 'other:requested-shared']);
});

test('delete: an admin-generated AI course with a single enrolled learner survives that learner\'s deletion', async () => {
  const { db, base, as } = await startApp([{ phone: '919876543210', name: 'Asha' }]);
  db.courses.push({ id: 'admin-course', title: 'Admin course', source: 'ai_generated', fsm_definition_id: null, settings: { aiGenerated: true, generator: { provider: 'meta', model: 'm' } } });
  db.enrollments.push({ learner_id: db.learners[0].id, course_id: 'admin-course' });
  assert.equal((await fetch(`${base}/me`, { method: 'DELETE', headers: as(tokenFor(db.learners[0])) })).status, 200);
  assert.deepEqual(db.courses.map((c) => c.id), ['admin-course']);
});

test('delete: the orphaned-course cleanup is part of the same single statement', async () => {
  const { db, base, as } = await startApp([{ phone: '919876543210', name: 'Asha' }]);
  const statements: string[] = [];
  const raw = db.raw.bind(db);
  db.raw = async (sql: string, p?: any[]) => { if (/DELETE FROM courses/.test(sql)) statements.push(sql); return raw(sql, p); };
  await fetch(`${base}/me`, { method: 'DELETE', headers: as(tokenFor(db.learners[0])) });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /DELETE FROM learners/, 'courses and learner are deleted by the one statement');
  assert.match(statements[0], /requestedByLearnerId/);
  assert.doesNotMatch(statements[0], /aiGenerated/, 'ownership, not the AI flag, decides what is deleted');
  assert.match(statements[0], /source <> 'authored'/);
});

// ── DELETE /api/sync/auth/account — Firebase ID token, no learner JWT ─────────

const custom = { firebase: { sign_in_provider: 'custom' } };
const google = { firebase: { sign_in_provider: 'google.com' } };

test('auth/account: a WhatsApp (wa:) user is deleted, and the response says so', async () => {
  const { db, deleteAccount } = await startApp([
    { phone: '919876543210', whatsapp_id: '919876543210', name: 'Asha' },
    { phone: '919000000001', whatsapp_id: '919000000001', name: 'Other' },
  ]);
  const res = await deleteAccount({ uid: 'wa:919876543210', ...custom });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(body.data.deleted, true);
  assert.deepEqual(db.learners.map((l) => l.name), ['Other']);
});

test('auth/account: a Google/email (fb:) user is deleted, with their sole AI course', async () => {
  const { db, deleteAccount } = await startApp([{ phone: 'fb:AbC123', name: 'Mira', email: 'mira@example.com' }]);
  db.courses.push({ id: 'mine', title: 'mine', source: 'ai_generated', fsm_definition_id: null, settings: { aiGenerated: true, requestedByLearnerId: db.learners[0].id } });
  db.enrollments.push({ learner_id: db.learners[0].id, course_id: 'mine' });
  const body: any = await (await deleteAccount({ uid: 'AbC123', ...google })).json();
  assert.equal(body.deleted, true);
  assert.equal(db.learners.length, 0);
  assert.equal(db.courses.length, 0, 'the orphaned-course cleanup is shared with DELETE /me');
});

test('auth/account: a Google token spoofing a wa: uid cannot delete the phone learner', async () => {
  const { db, deleteAccount } = await startApp([{ phone: '919876543210', whatsapp_id: '919876543210', name: 'Victim' }]);
  for (const firebase of [google.firebase, { sign_in_provider: 'password' }, { sign_in_provider: 'anonymous' }, undefined]) {
    const res = await deleteAccount({ uid: 'wa:919876543210', phone: '+919876543210', phone_number: '+919876543210', firebase });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).deleted, false, `provider ${firebase?.sign_in_provider}`);
    assert.equal(db.learners.length, 1, 'the victim\'s row is untouched');
  }
});

test('auth/account: a missing learner is 200 deleted:false, and no row is ever created', async () => {
  const { db, deleteAccount } = await startApp([]);
  for (const claims of [{ uid: 'wa:919876543210', ...custom }, { uid: 'NoSuchUser', ...google },
    { uid: 'p1', phone_number: '+919876543210', firebase: { sign_in_provider: 'phone' } }]) {
    const res = await deleteAccount(claims);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).deleted, false);
  }
  assert.equal(db.learners.length, 0, 'deletion must never create a learner');
});

test('auth/account: an invalid token is 401; a missing one is 400; no Firebase configuration is 503', async () => {
  const { deleteAccount, base } = await startApp([{ phone: '919876543210', name: 'Asha' }]);
  assert.equal((await deleteAccount('not-a-token')).status, 401);
  assert.equal((await deleteAccount({ nouid: true })).status, 401);
  assert.equal((await deleteAccount({ uid: 'wa:12', ...custom })).status, 401); // malformed trusted phone
  const none = await fetch(`${base}/auth/account`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 400);
  const off = await startApp([], false);
  assert.equal((await off.deleteAccount({ uid: 'x' })).status, 503);
});

test('auth/account: revocation is NOT checked, so a user mid-way through deleting their Firebase account can finish', async () => {
  const { deleteAccount, firebase } = await startApp([{ phone: 'fb:u1', name: 'Mira' }]);
  await deleteAccount({ uid: 'u1', ...google });
  assert.deepEqual(firebase.calls.verify.map((c) => c.checkRevoked), [false]);
});

test('auth/account: rate limited to 5 per hour per IP', async () => {
  const { deleteAccount } = await startApp([]);
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await deleteAccount({ uid: `u${i}`, ...google })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
});

test('auth/account: it is public (no bearer token needed) and uses the same single statement as DELETE /me', async () => {
  const { db, deleteAccount } = await startApp([{ phone: 'fb:u1', name: 'Mira' }]);
  const statements: string[] = [];
  const raw = db.raw.bind(db);
  db.raw = async (sql: string, p?: any[]) => { if (/DELETE FROM learners/.test(sql)) statements.push(sql); return raw(sql, p); };
  assert.equal((await deleteAccount({ uid: 'u1', ...google })).status, 200);
  assert.equal(statements.length, 1);
  const { DELETE_ACCOUNT_SQL } = await import('../../services/accountDeletion.js');
  assert.equal(statements[0], DELETE_ACCOUNT_SQL);
});

// ── POST /api/sync/auth/account/delete — the same operation for clients that cannot send a DELETE body ──

test('auth/account/delete (POST): same handler and responses as DELETE', async () => {
  const { db, base } = await startApp([
    { phone: '919876543210', whatsapp_id: '919876543210', name: 'Asha' },
    { phone: 'fb:AbC123', name: 'Mira' },
  ]);
  const post = (claims: object | string) =>
    fetch(`${base}/auth/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: typeof claims === 'string' ? claims : JSON.stringify(claims) }) });

  const wa = await post({ uid: 'wa:919876543210', ...custom });
  assert.equal(wa.status, 200);
  assert.deepEqual(await wa.json(), { success: true, deleted: true, data: { deleted: true } });
  const fb: any = await (await post({ uid: 'AbC123', ...google })).json();
  assert.equal(fb.deleted, true);
  assert.equal(db.learners.length, 0);

  const again: any = await (await post({ uid: 'AbC123', ...google })).json();
  assert.deepEqual(again, { success: true, deleted: false, data: { deleted: false } });
  assert.equal((await post('not-a-token')).status, 401);
  assert.equal((await fetch(`${base}/auth/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('auth/account/delete (POST): a spoofed wa: uid from Google deletes nothing, and revocation is not checked', async () => {
  const { db, base, firebase } = await startApp([{ phone: '919876543210', whatsapp_id: '919876543210', name: 'Victim' }]);
  const res = await fetch(`${base}/auth/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: JSON.stringify({ uid: 'wa:919876543210', phone: '+919876543210', ...google }) }) });
  assert.equal(((await res.json()) as any).deleted, false);
  assert.equal(db.learners.length, 1);
  assert.deepEqual(firebase.calls.verify.map((c) => c.checkRevoked), [false]);
});

test('auth/account/delete (POST) and DELETE share one limit of 5 per hour per IP', async () => {
  const { base, deleteAccount } = await startApp([]);
  const post = () => fetch(`${base}/auth/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: JSON.stringify({ uid: 'u', ...google }) }) });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await post()).status);
  for (let i = 0; i < 2; i++) statuses.push((await deleteAccount({ uid: 'u', ...google })).status);
  statuses.push((await post()).status, (await deleteAccount({ uid: 'u', ...google })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
});
