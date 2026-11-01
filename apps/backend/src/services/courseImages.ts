/**
 * Best-effort image generation for a saved course: one cover plus one image per module.
 * Failures are logged and never fail the lesson; a lesson without an image is still valid.
 */

import { publicBaseUrl } from '@ekatra/messaging';
import { logger } from '../lib/logger.js';

export { publicBaseUrl };

export const IMAGE_STYLE_SUFFIX = 'flat, friendly educational illustration, bright colors, no text, no letters, no numbers';
/** Longest the request waits for images; the rest attach in the background. */
export const IMAGE_BUDGET_MS = 60_000;
/** The whole lesson request (text + images) should finish within this. */
export const REQUEST_DEADLINE_MS = 240_000;
const DEADLINE_MARGIN_MS = 15_000;

/** Wait for images min(60 s, 240 s − time already spent − margin); never negative. */
export function imageBudgetMs(elapsedMs: number): number {
  return Math.max(0, Math.min(IMAGE_BUDGET_MS, REQUEST_DEADLINE_MS - elapsedMs - DEADLINE_MARGIN_MS));
}

export const withImageStyle = (prompt: string) => `${prompt.trim().replace(/[.\s]+$/, '')}. ${IMAGE_STYLE_SUFFIX}`;

export interface ImageDb {
  raw(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface ImageJob {
  kind: 'cover' | 'module';
  lessonId: string | null;
  prompt: string;
}

export interface CourseImageDeps {
  db: ImageDb;
  createImage: (prompt: string) => Promise<Buffer>;
  /** How long to wait before returning; images still running keep attaching afterwards. */
  budgetMs?: number;
}

/** Relative path stored in the database; made absolute only when a bundle or message is built. */
export const mediaPath = (id: string) => `/api/sync/media/${id}`;

/**
 * Generates and stores every image in parallel, then points lessons.media_url and
 * courses.settings.coverImageUrl at them (as relative paths). Waits at most `budgetMs`;
 * images that miss it keep running and attach later, so the caller must tolerate that.
 */
export async function generateCourseImages(
  courseId: string,
  jobs: ImageJob[],
  deps: CourseImageDeps,
): Promise<{ stored: number; failed: number; bytes: number[] }> {
  const { db, createImage } = deps;
  const bytes: number[] = [];

  const run = async (job: ImageJob) => {
    const image = await createImage(withImageStyle(job.prompt));
    const inserted = await db.raw(
      `INSERT INTO lesson_media (course_id, lesson_id, kind, mime, bytes)
       VALUES ($1, $2, $3, 'image/jpeg', $4) RETURNING id`,
      [courseId, job.lessonId, job.kind, image],
    );
    const url = mediaPath(inserted.rows[0].id);
    if (job.kind === 'cover') {
      await db.raw(
        `UPDATE courses SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('coverImageUrl', $1::text)
         WHERE id = $2`,
        [url, courseId],
      );
    } else {
      await db.raw(`UPDATE lessons SET media_url = $1 WHERE id = $2`, [url, job.lessonId]);
    }
    bytes.push(image.length);
  };

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.budgetMs ?? IMAGE_BUDGET_MS);
  });

  const settled = Promise.allSettled(
    jobs.map((job) =>
      run(job).catch((err) => {
        logger.warn(`Image generation failed (${job.kind}${job.lessonId ? ` ${job.lessonId}` : ''}): ${err?.message}`);
        throw err;
      }),
    ),
  );
  const outcome = await Promise.race([settled, budget]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    logger.warn(`Image budget exceeded for course ${courseId}; remaining images will attach in the background`);
    settled.then((rs) => {
      const ok = rs.filter((r) => r.status === 'fulfilled').length;
      logger.info(`Late images for course ${courseId}: ${ok} of ${jobs.length} attached in total`);
    });
    return { stored: bytes.length, failed: jobs.length - bytes.length, bytes };
  }
  const failed = outcome.filter((r) => r.status === 'rejected').length;
  return { stored: jobs.length - failed, failed, bytes };
}
