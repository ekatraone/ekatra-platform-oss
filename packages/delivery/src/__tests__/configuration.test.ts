import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationErrors, messagingConfiguration } from '../configuration.js';

const cloud = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://test', REDIS_URL: 'redis://test',
  JWT_SECRET: 'x'.repeat(32), META_PHONE_NUMBER_ID: 'test-phone', META_ACCESS_TOKEN: 'test-token',
  META_APP_SECRET: 'test-secret', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
};

test('Cloud API does not require unused Twilio or AI credentials', () => {
  assert.deepEqual(configurationErrors(cloud, 'api'), []);
});
test('explicit provider wins over stale credentials', () => {
  assert.equal(messagingConfiguration({ ...cloud, WHATSAPP_PROVIDER: 'cloudapi', TWILIO_ACCOUNT_SID: 'old', TWILIO_AUTH_TOKEN: 'old' }).provider, 'cloudapi');
});
test('selected Cloud API cannot bypass signatures by adding Twilio credentials', () => {
  const errors = configurationErrors({ ...cloud, WHATSAPP_PROVIDER: 'cloudapi', META_APP_SECRET: '', TWILIO_ACCOUNT_SID: 'old', TWILIO_AUTH_TOKEN: 'old' }, 'api');
  assert.ok(errors.includes('META_APP_SECRET is required'));
});
test('API requires production Redis; worker requires Redis in every environment', () => {
  assert.ok(configurationErrors({ ...cloud, REDIS_URL: '' }, 'api').includes('REDIS_URL is required'));
  assert.ok(configurationErrors({ ...cloud, NODE_ENV: 'development', REDIS_URL: '' }, 'worker').includes('REDIS_URL is required'));
});
test('worker uses the same provider configuration without requiring an admin JWT', () => {
  assert.deepEqual(configurationErrors({ ...cloud, JWT_SECRET: '' }, 'worker'), []);
});
test('unknown provider fails closed without disclosing credentials', () => {
  const errors = configurationErrors({ ...cloud, WHATSAPP_PROVIDER: 'gramiq' }, 'api');
  assert.equal(errors.length, 1);
  assert.ok(!errors.join().includes('test-token'));
});
