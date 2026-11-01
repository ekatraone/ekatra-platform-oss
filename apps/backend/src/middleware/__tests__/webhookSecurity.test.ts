import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, verifySharedSecret } from '../webhookSecurity.js';

test('Meta validates the original bytes including whitespace and Unicode', () => {
  const body = Buffer.from('{ "text": "नमस्ते", "n": 1 }\n');
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, 'test-secret'), true);
  assert.equal(verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), signature, 'test-secret'), false);
  assert.equal(verifyMetaSignature(body, signature, 'wrong-secret'), false);
});
test('Meta rejects missing secrets, missing bytes, and malformed signatures', () => {
  for (const signature of [undefined, '', [], 'sha256=ab', `sha256=${'g'.repeat(64)}`]) {
    assert.equal(verifyMetaSignature(Buffer.from('{}'), signature, 'test-secret'), false);
  }
  assert.equal(verifyMetaSignature(undefined, 'sha256=' + 'a'.repeat(64), 'test-secret'), false);
  assert.equal(verifyMetaSignature(Buffer.from('{}'), 'sha256=' + 'a'.repeat(64), undefined), false);
});
test('shared secrets fail closed, including when both are absent', () => {
  assert.equal(verifySharedSecret(undefined, undefined), false);
  assert.equal(verifySharedSecret('', ''), false);
  assert.equal(verifySharedSecret(['secret'], 'secret'), false);
  assert.equal(verifySharedSecret('short', 'longer-secret'), false);
  assert.equal(verifySharedSecret('secret', 'secret'), true);
});
