/** Durable sign-in caps: 10 codes/day/phone, 20 wrong/day then a 24 h lock, global daily cap. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtpLimits, dailyCap, DEFAULT_DAILY_CAP } from '../otpLimits.js';
import { makeAuthDb } from '../../routes/__tests__/fakeAuthDb.js';

const PHONE = '+919876543210';
const HOUR = 3_600_000;

test('at most 10 codes per phone in 24 hours; the 11th is refused, and it frees up after a day', async () => {
  let t = Date.now();
  const limits = new OtpLimits(makeAuthDb([], () => t), {});
  for (let i = 0; i < 10; i++) assert.equal(await limits.claimStart(PHONE), 'ok', `code ${i + 1}`);
  assert.equal(await limits.claimStart(PHONE), 'phone_cap');
  assert.equal(await limits.claimStart('+919000000001'), 'ok'); // other numbers unaffected
  t += 25 * HOUR;
  assert.equal(await limits.claimStart(PHONE), 'ok');
});

test('20 wrong guesses start a 1-hour lock that blocks codes and guesses, then it lifts', async () => {
  let t = Date.now();
  const limits = new OtpLimits(makeAuthDb([], () => t), {});
  for (let i = 0; i < 19; i++) await limits.recordWrong(PHONE);
  assert.equal(await limits.isLocked(PHONE), false);
  await limits.recordWrong(PHONE);
  assert.equal(await limits.isLocked(PHONE), true);
  assert.equal(await limits.claimStart(PHONE), 'locked');
  t += 59 * 60_000;
  assert.equal(await limits.isLocked(PHONE), true);
  t += 2 * 60_000;
  assert.equal(await limits.isLocked(PHONE), false);
  assert.equal(await limits.claimStart(PHONE), 'ok');
});

test('a second lock within 24 hours escalates to 24 hours, and needs 20 fresh wrong guesses', async () => {
  let t = Date.now();
  const db = makeAuthDb([], () => t);
  const limits = new OtpLimits(db, {});
  for (let i = 0; i < 20; i++) await limits.recordWrong(PHONE);
  t += 61 * 60_000; // first lock over
  assert.equal(await limits.isLocked(PHONE), false);

  // one stray wrong guess after the lock does not re-lock: only guesses since the lock count
  await limits.recordWrong(PHONE);
  assert.equal(await limits.isLocked(PHONE), false);
  assert.equal(db.events.filter((e) => e.kind === 'lock').length, 1);

  for (let i = 0; i < 19; i++) await limits.recordWrong(PHONE); // 20 since the first lock
  assert.equal(db.events.filter((e) => e.kind === 'lock').length, 2);
  assert.equal(await limits.isLocked(PHONE), true);

  t += 2 * 3_600_000; // 1 h lock would be over by now
  assert.equal(await limits.isLocked(PHONE), true, 'second lock lasts 24 h');
  t += 23 * 3_600_000;
  assert.equal(await limits.isLocked(PHONE), false);
});

test('a lone lock more than 24 hours old does not escalate the next one', async () => {
  let t = Date.now();
  const db = makeAuthDb([], () => t);
  const limits = new OtpLimits(db, {});
  for (let i = 0; i < 20; i++) await limits.recordWrong(PHONE);
  t += 25 * 3_600_000;
  for (let i = 0; i < 20; i++) await limits.recordWrong(PHONE);
  assert.equal(await limits.isLocked(PHONE), true);
  t += 61 * 60_000;
  assert.equal(await limits.isLocked(PHONE), false, 'back to a 1 h lock');
});

test('wrong guesses spread over more than a day never lock', async () => {
  let t = Date.now();
  const limits = new OtpLimits(makeAuthDb([], () => t), {});
  for (let i = 0; i < 30; i++) { await limits.recordWrong(PHONE); t += 2 * HOUR; }
  assert.equal(await limits.isLocked(PHONE), false);
});

test('a lock is only written once while it lasts', async () => {
  const db = makeAuthDb();
  const limits = new OtpLimits(db, {});
  for (let i = 0; i < 25; i++) await limits.recordWrong(PHONE);
  assert.equal(db.events.filter((e) => e.kind === 'lock').length, 1);
});

test('the global daily cap defaults to 500, is set by OTP_DAILY_CAP, and counts across phones', async () => {
  assert.equal(dailyCap({}), DEFAULT_DAILY_CAP);
  assert.equal(DEFAULT_DAILY_CAP, 500);
  assert.equal(dailyCap({ OTP_DAILY_CAP: '25' }), 25);
  assert.equal(dailyCap({ OTP_DAILY_CAP: 'junk' }), 500);
  assert.equal(dailyCap({ OTP_DAILY_CAP: '0' }), 500);

  const limits = new OtpLimits(makeAuthDb(), { OTP_DAILY_CAP: '3' });
  assert.equal(await limits.claimStart('+919000000001'), 'ok');
  assert.equal(await limits.claimStart('+919000000002'), 'ok');
  assert.equal(await limits.claimStart('+919000000003'), 'ok');
  assert.equal(await limits.claimStart('+919000000004'), 'global_cap');
});

test('the counters live in the database, so a new instance (a restart) sees them', async () => {
  const db = makeAuthDb();
  for (let i = 0; i < 10; i++) await new OtpLimits(db, {}).claimStart(PHONE);
  assert.equal(await new OtpLimits(db, {}).claimStart(PHONE), 'phone_cap');
});

test('hitting the global daily cap logs a warning that names no phone number', async () => {
  const { logger } = await import('../../lib/logger.js');
  const warnings: unknown[][] = [];
  const orig = (logger as any).warn;
  (logger as any).warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    const limits = new OtpLimits(makeAuthDb(), { OTP_DAILY_CAP: '1' });
    assert.equal(await limits.claimStart('+919000000001'), 'ok');
    assert.equal(warnings.length, 0);
    assert.equal(await limits.claimStart('+919000000002'), 'global_cap');
  } finally {
    (logger as any).warn = orig;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /global daily cap reached/);
  assert.ok(!JSON.stringify(warnings).match(/\+?91900000000/), 'no phone number in the warning');
});

test('refundStart gives back the most recent code, so a failed send does not burn the quota', async () => {
  const limits = new OtpLimits(makeAuthDb(), { OTP_DAILY_CAP: '500' });
  for (let i = 0; i < 10; i++) assert.equal(await limits.claimStart(PHONE), 'ok');
  assert.equal(await limits.claimStart(PHONE), 'phone_cap');
  await limits.refundStart(PHONE);
  assert.equal(await limits.claimStart(PHONE), 'ok');
  assert.equal(await limits.claimStart(PHONE), 'phone_cap');
  // refunding one number does not touch another's
  await limits.claimStart('+919000000001');
  await limits.refundStart(PHONE);
  assert.equal(await limits.claimStart('+919000000001'), 'ok');
});
