/**
 * Find or create the demo learner by phone and print a 30-day learner token.
 * On the demo deploy the phone is the user's WhatsApp number, so the WhatsApp
 * learner and the app learner are the same row.
 *
 * Usage (JWT_SECRET must be the target environment's secret):
 *   npx tsx src/scripts/issueDemoLearner.ts --phone +910000000042 [--name "Demo"]
 */

import { assertSafeDatabase } from './safeDb.js';

assertSafeDatabase();

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const phone = arg('--phone');
const name = arg('--name') ?? 'Demo Learner';
if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
  console.error('Usage: issueDemoLearner.ts --phone <E.164, e.g. +910000000042> [--name "Demo"]');
  process.exit(1);
}
const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set');
  process.exit(1);
}

const { initializeDatabase, db } = await import('@ekatra/database');
initializeDatabase({ connectionString: process.env.DATABASE_URL });
const { findOrCreateLearnerByPhone, signLearnerToken, defaultOrganizationId } = await import('../services/learnerIdentity.js');

if (!(await defaultOrganizationId(db))) {
  await db.raw(`INSERT INTO organizations (name, slug) VALUES ('Ekatra Demo', 'ekatra-demo')`);
}

const result = await findOrCreateLearnerByPhone(db, { phone, name });
if (!result) {
  console.error('Could not find or create the learner');
  process.exit(1);
}
const { learner, created } = result;

console.log(JSON.stringify({ learnerId: learner.id, organizationId: learner.organization_id, phone: learner.phone, created }));
console.log(`TOKEN=${signLearnerToken(learner, secret)}`);
process.exit(0);
