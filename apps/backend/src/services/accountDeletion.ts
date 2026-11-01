/**
 * Account deletion, shared by DELETE /api/sync/me (learner token) and DELETE /api/sync/auth/account
 * (Firebase ID token).
 *
 * One SQL statement of data-modifying CTEs, which is a single transaction: all or nothing.
 *  - The learners foreign keys cascade to enrollments, lesson_progress, learner_events, quiz_responses,
 *    flashcard_progress and sync_lesson_requests.
 *  - message_log and failed_messages only SET NULL, so they are deleted explicitly, as are the sign-in
 *    codes and ledger rows for the number.
 *  - Courses generated FOR this learner (settings.requestedByLearnerId, or, for courses made before that
 *    stamp existed, linked through their sync_lesson_requests) are deleted when no other learner is
 *    enrolled; their lessons, questions and images cascade. Authored and FSM-linked courses always stay,
 *    and so does anything not generated for this learner (an admin-generated AI course with a single
 *    enrolled learner is not theirs). Every CTE reads the same pre-delete snapshot, so the "no other
 *    learner" test is not fooled by the enrollment cascade.
 */

import type { IdentityDb } from './learnerIdentity.js';

export const DELETE_ACCOUNT_SQL = `WITH l AS (
           SELECT id, phone FROM learners WHERE id = $1 AND organization_id = $2
         ), numbers AS (
           SELECT phone AS p FROM l
           UNION SELECT '+' || regexp_replace(phone, '\\D', '', 'g') FROM l WHERE phone !~ '^fb:'
         ), orphaned AS (
           SELECT c.id FROM courses c
           WHERE c.source <> 'authored' AND c.fsm_definition_id IS NULL
             AND (c.settings->>'requestedByLearnerId' = (SELECT id::text FROM l)
                  OR c.id IN (SELECT course_id FROM sync_lesson_requests WHERE learner_id IN (SELECT id FROM l) AND course_id IS NOT NULL))
             AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.learner_id NOT IN (SELECT id FROM l))
         ), otp AS (
           DELETE FROM otp_challenges WHERE phone IN (SELECT p FROM numbers) RETURNING 1
         ), events AS (
           DELETE FROM otp_events WHERE phone IN (SELECT p FROM numbers) RETURNING 1
         ), msgs AS (
           DELETE FROM message_log WHERE learner_id IN (SELECT id FROM l) RETURNING 1
         ), failed AS (
           DELETE FROM failed_messages WHERE learner_id IN (SELECT id FROM l) RETURNING 1
         ), courses_gone AS (
           DELETE FROM courses WHERE id IN (SELECT id FROM orphaned) RETURNING id
         ), gone AS (
           DELETE FROM learners WHERE id IN (SELECT id FROM l) RETURNING id
         )
         SELECT (SELECT COUNT(*) FROM gone)::int AS deleted`;

/** Returns true when a learner row was deleted, false when there was nothing to delete. */
export async function deleteLearnerAccount(db: IdentityDb, learnerId: string, organizationId: string): Promise<boolean> {
  const result = await db.raw(DELETE_ACCOUNT_SQL, [learnerId, organizationId]);
  return Boolean(result.rows[0]?.deleted);
}
