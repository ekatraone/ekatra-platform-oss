import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSend } from '../sendResult.js';

test('resolved provider rejection is a delivery failure', async () => {
  await assert.rejects(checkedSend(Promise.resolve({ success: false, error: 'Rejected' })), /rejected delivery/);
});
test('transport errors propagate and successful provider IDs are preserved', async () => {
  await assert.rejects(checkedSend(Promise.reject(new Error('timeout'))), /timeout/);
  const sent = { success: true, messageId: 'test-id' };
  assert.deepEqual(await checkedSend(Promise.resolve(sent)), sent);
});
test('a permanent skip (no channel) is not a failure, so it is never retried or dead-lettered', async () => {
  const skipped = { success: false, permanent: true, error: 'recipient has no messaging channel (app-only learner)' };
  assert.deepEqual(await checkedSend(Promise.resolve(skipped)), skipped);
  // an ordinary failure is still a failure
  await assert.rejects(checkedSend(Promise.resolve({ success: false, error: 'Rejected' })), /rejected delivery/);
});
