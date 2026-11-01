/**
 * Course Generator Service
 *
 * Uses Azure OpenAI GPT-4o to generate a structured micro-course from a topic,
 * then persists it into the database (courses + lessons + quiz_questions tables).
 */

import { llmChat, llmSource } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { metaModelClient, metaModelId } from '../lib/metaModelClient.js';
import { generateCourseImages, imageBudgetMs, publicBaseUrl, ImageJob } from './courseImages.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

// ── Types ──────────────────────────────────────────────────────────────────

export interface CourseGenerationParams {
  topic: string;
  goal?: string;
  language?: string;   // ISO 639-1, default 'en'
  style?: string;      // 'conversational' | 'structured' | 'story-driven'
  numDays?: number;    // default 3, max 5
  numModules?: number; // modules per day, default 3, max 5
  organizationId: string;
  /**
   * Set when the course is generated FOR a learner (the sync lesson request, the WhatsApp chat flow).
   * Admin or API generation leaves it unset. Account deletion removes only courses carrying this stamp.
   */
  requestedByLearnerId?: string;
  /** 'micro' = 1 day × 3 short modules; defaults to COURSE_SIZE env or 'standard'. */
  size?: 'micro' | 'standard';
  /** Force a provider (e.g. 'meta' for Muse) instead of the llmChat fallback chain. */
  provider?: 'meta';
  /** Skip the existing-course reuse check and always generate. */
  force?: boolean;
}

interface GeneratedQuiz {
  question: string;
  options: string[];   // Exactly 4 options
  correctAnswer: string; // 'A' | 'B' | 'C' | 'D'
  explanation: string;
}

interface GeneratedModule {
  title: string;
  content: string;
  quiz: GeneratedQuiz;
  imagePrompt?: string;
}

interface GeneratedDay {
  dayNumber: number;
  modules: GeneratedModule[];
  comprehensionQuestions: GeneratedQuiz[];
}

interface GeneratedCourse {
  title: string;
  description: string;
  coverImagePrompt?: string;
  /** Provider and model that actually produced the text; stamped into settings.generator. */
  generator?: { provider: string; model: string };
  days: GeneratedDay[];
}

export type CourseSize = 'micro' | 'standard';

/**
 * Settings stored on a generated course. Every AI course records what produced it
 * (the phone only downloads courses that have a generator): the provider and model that
 * actually answered, or the forced provider when the answer carried no attribution.
 */
export function buildCourseSettings(
  courseData: { days: unknown[]; generator?: { provider: string; model: string } },
  language: string,
  size: CourseSize,
  provider?: 'meta',
  requestedByLearnerId?: string,
) {
  return {
    language,
    aiGenerated: true,
    totalDays: courseData.days.length,
    size,
    ...(requestedByLearnerId ? { requestedByLearnerId } : {}),
    ...(courseData.generator
      ? { generator: courseData.generator }
      : provider === 'meta'
        ? { generator: { provider: 'meta', model: metaModelId() } }
        : {}),
  };
}

export function resolveCourseSize(size?: CourseSize): CourseSize {
  if (size) return size;
  return process.env.COURSE_SIZE === 'micro' ? 'micro' : 'standard';
}

// ── Dedup matching ─────────────────────────────────────────────────────────

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Whether an existing published course can be handed to a learner who asked
 * for `topic` in `language`. Only AI-generated, lesson-backed courses in the
 * same language qualify — authored (FSM-delivered) courses have no lesson rows
 * and an English course is no answer to a Hindi request.
 */
export function isReusableCourse(course: any, topic: string, language: string): boolean {
  if (!course?.title) return false;
  if (course.source === 'authored' || course.fsm_definition_id) return false;
  if (!course.settings?.aiGenerated) return false;
  if ((course.settings?.language ?? 'en') !== (language || 'en')) return false;

  // Match if the slugs share 80%+ of their words
  const topicWords = new Set(slugify(topic).split('-').filter((w: string) => w.length > 3));
  const courseWords = slugify(course.title).split('-').filter((w: string) => w.length > 3);
  if (topicWords.size === 0) return false;
  const overlap = courseWords.filter((w: string) => topicWords.has(w)).length;
  return overlap / topicWords.size >= 0.8;
}

// ── Service ────────────────────────────────────────────────────────────────

export class CourseGeneratorService {
  /**
   * Generate a full course and persist to DB. Returns the created course row.
   * If a published course with the same topic slug already exists for this org,
   * returns it directly without calling the LLM (deduplication).
   */
  async generate(params: CourseGenerationParams): Promise<any> {
    const {
      topic,
      goal,
      language = 'en',
      style = 'conversational',
      organizationId,
      provider,
      force = false,
      requestedByLearnerId,
    } = params;
    const size = resolveCourseSize(params.size);
    // The 3-minimum clamp applies only to standard courses.
    const numDays = size === 'micro' ? 1 : Math.min(Math.max(params.numDays ?? 3, 3), 5);
    const numModules = size === 'micro' ? 3 : Math.min(Math.max(params.numModules ?? 3, 3), 5);

    // ── Deduplication: check for existing published course ─────────────────
    if (!force) {
      const existing = await this.findExistingCourse(topic, organizationId, language);
      if (existing) {
        logger.info(`♻️  Reusing existing course "${existing.title}" (${existing.id}) for topic "${topic}"`);
        return existing;
      }
    }

    const started = Date.now();
    logger.info(`🎓 Generating ${size} course: "${topic}" (${numDays} days × ${numModules} modules, lang=${language})`);

    const courseData = await this.callLLM(topic, goal, language, style, numDays, numModules, size, provider);
    const course = await this.saveToDB(courseData, organizationId, language, size, provider, started, requestedByLearnerId);

    logger.info(`✅ Course saved: ${course.id} — "${course.title}"`);
    return course;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Slug-based dedup: normalise topic → check against existing course titles.
   * Returns the first matching reusable published course, or null.
   */
  private async findExistingCourse(topic: string, organizationId: string, language: string): Promise<any> {
    try {
      const db = await getDb();
      const { data: courses } = await db.courses.findAll({
        organizationId,
        status: 'published',
        limit: 50,
      });
      return courses.find((c: any) => isReusableCourse(c, topic, language)) ?? null;
    } catch {
      return null; // dedup failure should never block generation
    }
  }

  private async callLLM(
    topic: string,
    goal: string | undefined,
    language: string,
    style: string,
    numDays: number,
    numModules: number,
    size: CourseSize,
    provider?: 'meta',
  ): Promise<GeneratedCourse> {
    const micro = size === 'micro';
    const reviewCount = micro ? 2 : 3;
    const wordRange = micro ? '80-120 words' : '150-200 words';
    const goalLine = goal ? `\nLearner's goal: ${goal}` : '';
    const langLine = language !== 'en' ? `\nRespond entirely in language code: ${language}` : '';

    const systemPrompt = `You are an expert curriculum designer creating WhatsApp micro-courses.
Design bite-sized, mobile-friendly modules that a learner can read in 2-3 minutes each.

Rules:
- Use simple, conversational language. Avoid jargon.
- Use \\n\\n to separate paragraphs within module content.
- Each module MUST have exactly ONE quiz question (4 options, one correct answer A/B/C/D).
- Each day MUST have exactly ${reviewCount} comprehension questions that test understanding across all modules that day.
- NO flashcards — do not include any flashcard fields.
- Give the course a "coverImagePrompt" and every module an "imagePrompt": one plain sentence describing a simple illustration of the idea (objects and scenes only; the image must contain no words, letters or numbers).
- Respond ONLY with valid JSON. No markdown fences, no commentary.${langLine}`;

    const userPrompt = `Create a ${numDays}-day micro-course about: "${topic}"${goalLine}
Style: ${style}
Each day has exactly ${numModules} modules.

Return this exact JSON structure:
{
  "title": "Course title (max 60 characters)",
  "description": "What learners will gain (2-3 sentences)",
  "coverImagePrompt": "One sentence describing a cover illustration for the whole course.",
  "days": [
    {
      "dayNumber": 1,
      "modules": [
        {
          "title": "Module title (max 60 characters)",
          "content": "Module body (${wordRange}). Use \\n\\n for paragraphs. Use *bold* for key terms.",
          "imagePrompt": "One sentence describing an illustration for this module.",
          "quiz": {
            "question": "Question testing understanding of this module?",
            "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
            "correctAnswer": "A",
            "explanation": "Why this answer is correct (1-2 sentences)."
          }
        }
      ],
      "comprehensionQuestions": [
        {
          "question": "Question reviewing Day 1 content?",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctAnswer": "B",
          "explanation": "Explanation here."
        }
      ]
    }
  ]
}

Ensure comprehensionQuestions has exactly ${reviewCount} items per day.`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const completion = await llmChat({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          ...(provider ? { provider } : {}),
          // Reasoning models spend part of this on hidden reasoning before emitting
          // the course JSON — 4000 truncates mid-output for 3+ day courses.
          maxTokens: 8000,
        });

        const raw = (completion.choices[0]?.message?.content ?? '').trim();
        // Strip accidental markdown code fences
        const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        const parsed = JSON.parse(jsonStr) as GeneratedCourse;

        if (!parsed.title || !Array.isArray(parsed.days) || parsed.days.length === 0) {
          throw new Error('LLM returned invalid course structure');
        }

        const source = llmSource(completion);
        if (source) parsed.generator = { provider: source.provider, model: source.model };

        const totalModules = parsed.days.reduce((sum, d) => sum + (d.modules?.length ?? 0), 0);
        logger.info(`📝 LLM generated ${parsed.days.length} days / ${totalModules} modules for "${parsed.title}"`);
        return parsed;
      } catch (err) {
        logger.warn(`Course generation attempt ${attempt}/3 failed:`, err);
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    throw new Error('Course generation failed after 3 attempts');
  }

  /** Best-effort: never throws, so a lesson is never lost to an image problem. */
  private async attachImages(db: any, courseId: string, jobs: ImageJob[], startedAt: number): Promise<void> {
    if (!jobs.length || process.env.COURSE_IMAGES === 'off' || !metaModelClient.isAvailable()) return;
    try {
      const baseUrl = publicBaseUrl();
      if (!baseUrl) {
        logger.warn('Skipping course images: set PUBLIC_BASE_URL (or WEBHOOK_BASE_URL, https in production) so image links resolve');
        return;
      }
      const imagesStarted = Date.now();
      const result = await generateCourseImages(courseId, jobs, {
        db,
        createImage: (prompt) => metaModelClient.createImage(prompt),
        budgetMs: imageBudgetMs(imagesStarted - startedAt),
      });
      logger.info(`🖼️  Images for course ${courseId}: ${result.stored} stored, ${result.failed} failed in ${Date.now() - imagesStarted}ms`);
    } catch (err: any) {
      logger.warn(`Image generation skipped for course ${courseId}: ${err?.message}`);
    }
  }

  private async saveToDB(
    courseData: GeneratedCourse,
    organizationId: string,
    language: string,
    size: CourseSize,
    provider?: 'meta',
    startedAt: number = Date.now(),
    requestedByLearnerId?: string,
  ): Promise<any> {
    const db = await getDb();

    // 1. Create the course record
    const course = await db.courses.create({
      organizationId,
      title: courseData.title,
      description: courseData.description,
      status: 'published',
      settings: buildCourseSettings(courseData, language, size, provider, requestedByLearnerId),
    });

    // 2. Flatten days → modules, save each as a lesson row with day_number
    const imageJobs: ImageJob[] = [];
    if (courseData.coverImagePrompt) {
      imageJobs.push({ kind: 'cover', lessonId: null, prompt: courseData.coverImagePrompt });
    }
    let sequenceOrder = 1;
    for (const day of courseData.days) {
      for (const moduleData of day.modules) {
        const lesson = await db.lessons.create({
          courseId: course.id,
          title: moduleData.title,
          content: moduleData.content,
          contentType: 'text',
          sequenceOrder,
          durationMinutes: 3,
          dayNumber: day.dayNumber,
        });

        if (moduleData.imagePrompt) {
          imageJobs.push({ kind: 'module', lessonId: lesson.id, prompt: moduleData.imagePrompt });
        }

        if (moduleData.quiz) {
          const q = moduleData.quiz;
          await db.quiz.createQuestion({
            lessonId: lesson.id,
            question: q.question,
            questionType: 'multiple_choice',
            options: JSON.stringify(q.options),
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            sequenceOrder: 0,
          });
        }

        sequenceOrder++;
      }

      // 3. Save day-end comprehension questions as quiz_questions with no lesson
      //    We tag them with a special lesson: a synthetic "Day N Review" lesson
      if (Array.isArray(day.comprehensionQuestions) && day.comprehensionQuestions.length > 0) {
        const reviewLesson = await db.lessons.create({
          courseId: course.id,
          title: `Day ${day.dayNumber} Review`,
          content: '',
          contentType: 'review',
          sequenceOrder,  // Sits right after last module of the day
          durationMinutes: 2,
          dayNumber: day.dayNumber,
        });

        for (let qi = 0; qi < day.comprehensionQuestions.length; qi++) {
          const q = day.comprehensionQuestions[qi];
          await db.quiz.createQuestion({
            lessonId: reviewLesson.id,
            question: q.question,
            questionType: 'multiple_choice',
            options: JSON.stringify(q.options),
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            sequenceOrder: qi,
          });
        }

        sequenceOrder++;
      }
    }

    const totalModules = courseData.days.reduce((sum, d) => sum + d.modules.length, 0);
    logger.info(`✅ Saved ${courseData.days.length} days / ${totalModules} modules for course ${course.id}`);

    await this.attachImages(db, course.id, imageJobs, startedAt);
    return course;
  }
}

export const courseGenerator = new CourseGeneratorService();
