/**
 * POST /api/sync/join — public tester sign-in. Real router on an ephemeral port, in-memory learners.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createSyncRouter, testerJoinEnabled } from '../sync.js';

const SECRET = 'test-secret-for-join';
const CODE = 'tester-code-1234567'; // 19 characters (the minimum is 16)
const ORG = '00000000-0000-4000-8000-0000000000aa';

interface Learner { id: string; organization_id: string; phone: string; whatsapp_id: string | null; name: string | null; created_at: number }

let servers: Server[] = [];
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.DEMO_INVITE_CODE = CODE;
});
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function startApp(seed: Partial<Learner>[] = []) {
  const learners: Learner[] = seed.map((l, i) => ({
    id: `00000000-0000-4000-8000-00000000f0${i}`, organization_id: ORG, phone: '', whatsapp_id: null, name: null, created_at: i, ...l,
  }));
  let n = 100;
  const db = {
    learners,
    async raw(sql: string, p: any[] = []) {
      const has = (s: string) => sql.includes(s);
      if (has('FROM organizations')) return { rows: [{ id: ORG }] };
      if (has('WHERE organization_id = $1 AND (phone = $2 OR phone = $3 OR whatsapp_id = $3)')) {
        const found = learners.filter((l) => l.organization_id === p[0] && (l.phone === p[1] || l.phone === p[2] || l.whatsapp_id === p[2]));
        return { rows: found.sort((a, b) => a.created_at - b.created_at).slice(0, 1) };
      }
      if (has('INSERT INTO learners')) {
        if (learners.some((l) => l.organization_id === p[0] && l.phone === p[1])) return { rows: [] };
        const row: Learner = { id: `00000000-0000-4000-8000-00000000a${n++}`, organization_id: p[0], phone: p[1], whatsapp_id: p[1], name: p[2], created_at: n };
        learners.push(row);
        return { rows: [row] };
      }
      if (has('SELECT 1 FROM learners WHERE id = $1 AND organization_id = $2')) {
        return { rows: learners.some((l) => l.id === p[0] && l.organization_id === p[1]) ? [{}] : [] };
      }
      if (has('SELECT id, name, phone, language')) {
        const l = learners.find((x) => x.id === p[0])!;
        return { rows: [{ id: l.id, name: l.name, phone: l.phone, language: 'en' }] };
      }
      return { rows: [] }; // /me extras: courses, events, timezone, profile update
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: 'x' }) } }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const join = (body: object) => fetch(`${base}/api/sync/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { db, base, join };
}

test('join: disabled (404) when DEMO_INVITE_CODE is unset', async () => {
  delete process.env.DEMO_INVITE_CODE;
  const { join } = await startApp();
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210' })).status, 404);
  process.env.DEMO_INVITE_CODE = '';
  assert.equal((await join({ inviteCode: '', phone: '+919876543210' })).status, 404);
});

test('join: a wrong or missing invite code gets the same generic 401', async () => {
  const { join } = await startApp();
  const bodies: string[] = [];
  for (const body of [{ inviteCode: 'nope', phone: '+919876543210' }, { phone: '+919876543210' }, { inviteCode: 42, phone: 'x' }, {}]) {
    const res = await join(body);
    assert.equal(res.status, 401);
    bodies.push(JSON.stringify(await res.json()));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]), { success: false, error: 'Invalid invite code' });
});

test('join: a bad phone or name is a 400', async () => {
  const { join } = await startApp();
  for (const phone of ['919876543210', '+0123456789', '+1234567', '+1234567890123456', '+91 98765 43210', '+91abc', 12345, undefined]) {
    assert.equal((await join({ inviteCode: CODE, phone })).status, 400, String(phone));
  }
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210', name: 'x'.repeat(61) })).status, 400);
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210', name: 7 })).status, 400);
});

test('join: 8 digits is the shortest and 15 the longest accepted phone', async () => {
  const { join } = await startApp(); // fresh app: fresh per-IP limiter
  assert.equal((await join({ inviteCode: CODE, phone: '+12345678' })).status, 200);
  assert.equal((await join({ inviteCode: CODE, phone: '+123456789012345' })).status, 200);
});

test('join: rate limited to 10 per IP per hour (wrong-code guesses count)', async () => {
  const { join } = await startApp();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await join({ inviteCode: `guess-${i}`, phone: '+919876543210' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test('join: rate limited to 5 per phone per hour, other numbers unaffected', async () => {
  const { join } = await startApp();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await join({ inviteCode: CODE, phone: '+919876543210' })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal((await join({ inviteCode: CODE, phone: '+919000000001' })).status, 200);
});

test('join: wrong-code guesses do not consume the real owner\'s per-phone budget', async () => {
  const { join } = await startApp();
  for (let i = 0; i < 6; i++) await join({ inviteCode: 'wrong', phone: '+919876543210' });
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210' })).status, 200);
});

test('join: creates the learner, and a second join finds the same one', async () => {
  const { join, db } = await startApp();
  const first: any = await (await join({ inviteCode: CODE, phone: '+919876543210', name: 'Asha' })).json();
  assert.equal(first.success, true);
  assert.equal(first.data.learner.name, 'Asha');
  assert.equal(first.data.learner.phone, '+919876543210');
  const second: any = await (await join({ inviteCode: CODE, phone: '+919876543210', name: 'Someone Else' })).json();
  assert.equal(second.data.learner.id, first.data.learner.id);
  assert.equal(second.data.learner.name, 'Asha'); // an existing profile is never renamed
  assert.equal(db.learners.length, 1);
});

test('join: new rows are written the way the WhatsApp flow writes them (bare digits, whatsapp_id set)', async () => {
  const { join, db } = await startApp();
  await join({ inviteCode: CODE, phone: '+919876543210' });
  assert.equal(db.learners[0].phone, '919876543210');
  assert.equal(db.learners[0].whatsapp_id, '919876543210');
  assert.equal(db.learners[0].name, 'Friend'); // same default name as the WhatsApp flow
});

test('join: the WhatsApp-format and app-format phone resolve to the same learner', async () => {
  // A learner the WhatsApp flow created from the sender's WaId
  const wa = await startApp([{ phone: '919876543210', whatsapp_id: '919876543210', name: 'Friend' }]);
  const viaApp: any = await (await wa.join({ inviteCode: CODE, phone: '+919876543210' })).json();
  assert.equal(viaApp.data.learner.id, wa.db.learners[0].id);
  assert.equal(wa.db.learners.length, 1);

  // A row minted earlier by issueDemoLearner with the "+" form is found too
  const old = await startApp([{ phone: '+919876543210', whatsapp_id: null, name: 'Demo Learner' }]);
  const viaOld: any = await (await old.join({ inviteCode: CODE, phone: '+919876543210' })).json();
  assert.equal(viaOld.data.learner.id, old.db.learners[0].id);
  assert.equal(old.db.learners.length, 1);

  // Joining first, then WhatsApp's lookup (phone = '919876543210') finds the same row
  const first = await startApp();
  const joined: any = await (await first.join({ inviteCode: CODE, phone: '+919876543210' })).json();
  const waLookup = first.db.learners.find((l) => l.phone === '919876543210' || l.whatsapp_id === '919876543210');
  assert.equal(waLookup?.id, joined.data.learner.id);
});

test('join: the returned token has the learner format and passes /me', async () => {
  const { join, base } = await startApp();
  const { data }: any = await (await join({ inviteCode: CODE, phone: '+919876543210', name: 'Asha' })).json();
  const payload: any = jwt.verify(data.token, SECRET, { algorithms: ['HS256'] });
  assert.deepEqual(
    { role: payload.role, learnerId: payload.learnerId, organizationId: payload.organizationId },
    { role: 'learner', learnerId: data.learner.id, organizationId: ORG });
  assert.ok(payload.exp - payload.iat === 30 * 24 * 60 * 60, 'valid for 30 days');

  const me = await fetch(`${base}/api/sync/me`, { headers: { Authorization: `Bearer ${data.token}` } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as any).data.learner.id, data.learner.id);
});

// ── hardening ──────────────────────────────────────────────────────────────

test('join: a DEMO_INVITE_CODE shorter than 16 characters is treated as disabled', async () => {
  process.env.DEMO_INVITE_CODE = 'short-code-15chr'.slice(0, 15);
  const { join } = await startApp();
  assert.equal((await join({ inviteCode: process.env.DEMO_INVITE_CODE, phone: '+919876543210' })).status, 404);
  process.env.DEMO_INVITE_CODE = 'exactly-16-chars';
  assert.equal(process.env.DEMO_INVITE_CODE.length, 16);
  assert.equal((await join({ inviteCode: process.env.DEMO_INVITE_CODE, phone: '+919876543210' })).status, 200);
});

test('join: in production it is 404 unless ALLOW_TESTER_JOIN=1 is also set', async () => {
  process.env.NODE_ENV = 'production';
  const { join } = await startApp();
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210' })).status, 404);
  process.env.ALLOW_TESTER_JOIN = 'true'; // only the exact value 1 counts
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210' })).status, 404);
  process.env.ALLOW_TESTER_JOIN = '1';
  assert.equal((await join({ inviteCode: CODE, phone: '+919876543210' })).status, 200);
});

test('join: testerJoinEnabled covers every combination', () => {
  const code = 'a-long-enough-invite';
  assert.equal(testerJoinEnabled({}), false);
  assert.equal(testerJoinEnabled({ DEMO_INVITE_CODE: code }), true);
  assert.equal(testerJoinEnabled({ DEMO_INVITE_CODE: code, NODE_ENV: 'production' }), false);
  assert.equal(testerJoinEnabled({ DEMO_INVITE_CODE: code, NODE_ENV: 'production', ALLOW_TESTER_JOIN: '1' }), true);
  assert.equal(testerJoinEnabled({ NODE_ENV: 'production', ALLOW_TESTER_JOIN: '1' }), false);
});

test('join: a boot warning is logged when production has both ALLOW_TESTER_JOIN and a code', async () => {
  const { logger } = await import('../../lib/logger.js');
  const warnings: string[] = [];
  const orig = (logger as any).warn;
  (logger as any).warn = (...a: any[]) => { warnings.push(a.join(' ')); };
  try {
    process.env.NODE_ENV = 'production';
    await startApp();
    assert.equal(warnings.some((w) => /Tester sign-in/.test(w)), false);
    process.env.ALLOW_TESTER_JOIN = '1';
    await startApp();
    assert.equal(warnings.filter((w) => /Tester sign-in .* ENABLED in production/.test(w)).length, 1);
  } finally {
    (logger as any).warn = orig;
  }
});
