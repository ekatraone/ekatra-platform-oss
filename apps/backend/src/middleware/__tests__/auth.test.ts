import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireRole, signToken, verifyAdminToken } from '../auth.js';

process.env.JWT_SECRET = 'test-only-secret-not-for-production';
const admin = { userId: 'admin-1', email: 'admin@example.test', role: 'admin', organizationId: 'org-1' };

test('admin claims round trip without exposing unrelated token fields', () => {
  assert.deepEqual(verifyAdminToken(signToken(admin)), admin);
});
test('learner and incomplete tokens cannot authenticate as admin', () => {
  for (const payload of [
    { learnerId: 'learner-1', role: 'learner', organizationId: 'org-1' },
    { ...admin, role: 'learner' }, { ...admin, learnerId: 'learner-1' },
    { ...admin, organizationId: '' }, { ...admin, userId: null },
  ]) {
    assert.throws(() => verifyAdminToken(jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })));
  }
});
test('expired, unsigned, wrong-algorithm and non-expiring tokens are rejected', () => {
  assert.throws(() => verifyAdminToken(signToken(admin, -1)));
  assert.throws(() => verifyAdminToken(jwt.sign(admin, process.env.JWT_SECRET!, { algorithm: 'HS384', expiresIn: '1h' })));
  assert.throws(() => verifyAdminToken(jwt.sign(admin, process.env.JWT_SECRET!)));
  assert.throws(() => verifyAdminToken(jwt.sign(admin, '', { algorithm: 'none' })));
});

test('super-admin-only operations reject ordinary admins', () => {
  const middleware = requireRole('super_admin');
  let statusCode = 0;
  let nextCalled = false;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  };

  middleware({ auth: admin } as any, response as any, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);

  statusCode = 0;
  middleware({ auth: { ...admin, role: 'super_admin' } } as any, response as any, () => { nextCalled = true; });
  assert.equal(statusCode, 0);
  assert.equal(nextCalled, true);
});
