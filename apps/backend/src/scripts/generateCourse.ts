/**
 * Generate one Muse micro lesson from the command line (no learner involved).
 *
 * Usage (hack env loaded; MODEL_API_KEY, META_MODEL_API_BASE_URL, META_MODEL_ID exported):
 *   npx tsx src/scripts/generateCourse.ts "<topic>" [language]
 */

import { assertSafeDatabase } from './safeDb.js';

assertSafeDatabase();

const topic = process.argv[2];
const language = process.argv[3] ?? 'en';
if (!topic) {
  console.error('Usage: generateCourse.ts "<topic>" [language]');
  process.exit(1);
}

const { initializeDatabase, db } = await import('@ekatra/database');
initializeDatabase({ connectionString: process.env.DATABASE_URL });
const { courseGenerator } = await import('../services/courseGenerator.js');

const org = await db.organizations.getDefault();
if (!org) {
  console.error('No organization found. Run issueDemoLearner.ts first.');
  process.exit(1);
}

const started = Date.now();
const course = await courseGenerator.generate({
  topic,
  language,
  organizationId: org.id,
  size: 'micro',
  provider: 'meta',
  force: true,
});
const lessons = await db.lessons.findByCourse(course.id);
console.log(JSON.stringify({ courseId: course.id, title: course.title, lessons: lessons.length, ms: Date.now() - started }));
process.exit(0);
