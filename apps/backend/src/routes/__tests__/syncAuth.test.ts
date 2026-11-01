/**
 * /api/sync learner auth: tokens must expire, carry UUID ids, and match a live learner.
 * Runs the real router on an ephemeral port with a stub database.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createSyncRouter } from '../sync.js';

const SECRET = 'test-secret-for-sync-auth';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const LEARNER = '00000000-0000-4000-8000-0000000000b1';
const COURSE = '00000000-0000-4000-8000-0000000000c1';

let server: Server;
let base = '';
let knownLearner = true;
let prevSecret: string | undefined;

before(async () => {
  prevSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  const db = {
    async raw(sql: string) {
      if (sql.includes('FROM learners WHERE id = $1 AND organization_id = $2')) {
        return { rows: knownLearner ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: COURSE }) } }));
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret;
});

const sign = (payload: object, opts: jwt.SignOptions = { expiresIn: '1h' }) =>
  jwt.sign({ learnerId: LEARNER, phone: '+910000000042', role: 'learner', organizationId: ORG, ...payload }, SECRET, {
    algorithm: 'HS256',
    ...opts,
  });

const call = (token?: string) =>
  fetch(`${base}/api/sync/courses/${COURSE}/bundle`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('auth: a valid token for a live learner passes auth (404 comes from the bundle lookup)', async () => {
  knownLearner = true;
  assert.equal((await call(sign({}))).status, 404);
});

test('auth: missing, malformed or wrongly signed tokens get 401', async () => {
  assert.equal((await call()).status, 401);
  assert.equal((await call('garbage')).status, 401);
  assert.equal((await call(jwt.sign({ learnerId: LEARNER, role: 'learner', organizationId: ORG }, 'other', { expiresIn: '1h' }))).status, 401);
});

test('auth: a token without exp is rejected', async () => {
  knownLearner = true;
  assert.equal((await call(sign({}, {}))).status, 401);
});

test('auth: an expired token is rejected', async () => {
  assert.equal((await call(sign({}, { expiresIn: -60 }))).status, 401);
});

test('auth: a non-UUID learnerId or organizationId is a 401, not a database error', async () => {
  knownLearner = true;
  assert.equal((await call(sign({ learnerId: "1'; DROP TABLE learners;--" }))).status, 401);
  assert.equal((await call(sign({ learnerId: 'abc' }))).status, 401);
  assert.equal((await call(sign({ organizationId: 'nope' }))).status, 401);
});

test('auth: a token whose learner no longer exists is rejected', async () => {
  knownLearner = false;
  assert.equal((await call(sign({}))).status, 401);
  knownLearner = true;
});

test('lessons/request: the socket timeout is 330 s, above the client\'s 300 s', async () => {
  const { IncomingMessage } = await import('node:http');
  const original = IncomingMessage.prototype.setTimeout;
  const seen: number[] = [];
  IncomingMessage.prototype.setTimeout = function (this: any, ms: number, cb?: any) { seen.push(ms); return original.call(this, ms, cb); } as any;
  try {
    knownLearner = true;
    await fetch(`${base}/api/sync/lessons/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sign({})}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Compound interest', clientRequestId: '00000000-0000-4000-8000-0000000000e9' }),
    });
  } finally {
    IncomingMessage.prototype.setTimeout = original;
  }
  assert.ok(seen.includes(330_000), `setTimeout calls: ${seen.join(',')}`);
});

test('auth: a non-learner role is rejected', async () => {
  assert.equal((await call(sign({ role: 'admin' }))).status, 401);
});
