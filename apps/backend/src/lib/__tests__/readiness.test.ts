import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReadiness } from '../readiness.js';

test('healthy core dependencies make the API ready', async () => {
  assert.equal((await checkReadiness({ database: async () => {}, redis: async () => {} })).ready, true);
});
test('dependency failure is unavailable without exposing its error', async () => {
  const result = await checkReadiness({ database: async () => { throw new Error('secret-password'); } });
  assert.equal(result.ready, false);
  assert.equal(result.checks.database.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret-password'));
});
test('hung dependency has a bounded readiness timeout', async () => {
  const result = await checkReadiness({ redis: () => new Promise(() => {}) }, 10);
  assert.equal(result.ready, false);
});
