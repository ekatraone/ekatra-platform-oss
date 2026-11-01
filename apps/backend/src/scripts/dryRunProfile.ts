/**
 * M13a dry run — compute a learner profile from a dummy event trail, no DB.
 *
 * Usage: npx tsx src/scripts/dryRunProfile.ts [path/to/events.json] [timezone]
 * Defaults to the checked-in AC1 fixture trail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeProfile } from '../services/learnerProfile.js';

const defaultFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../services/__tests__/__fixtures__/learnerEventsTrail.json',
);

const file = process.argv[2] ?? defaultFixture;
const tz = process.argv[3] ?? null;

const events = JSON.parse(readFileSync(file, 'utf-8'));
const profile = computeProfile(events, tz);

console.log(`\n📊 Learner profile from ${events.length} events (${path.basename(file)}, tz=${profile.timezone})\n`);
console.log(JSON.stringify(profile, null, 2));
