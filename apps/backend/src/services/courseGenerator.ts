/**
 * Course Generator Service
 *
 * Uses Azure OpenAI GPT-4o to generate a structured micro-course from a topic,
 * then persists it into the database (courses + lessons + quiz_questions tables).
 */

import { llmChat } from '../lib/llm.js';
import { logger } from '../lib/logger.js';

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
}

interface GeneratedDay {
  dayNumber: number;
  modules: GeneratedModule[];
  comprehensionQuestions: GeneratedQuiz[];
}

interface GeneratedCourse {
  title: string;
  description: string;
  days: GeneratedDay[];
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
      numDays = Math.min(Math.max(params.numDays ?? 3, 3), 5),
      numModules = Math.min(Math.max(params.numModules ?? 3, 3), 5),
      organizationId,
    } = params;

    // ── Deduplication: check for existing published course ─────────────────
    const existing = await this.findExistingCourse(topic, organizationId);
    if (existing) {
      logger.info(`♻️  Reusing existing course "${existing.title}" (${existing.id}) for topic "${topic}"`);
      return existing;
    }

    logger.info(`🎓 Generating course: "${topic}" (${numDays} days × ${numModules} modules, lang=${language})`);

    const courseData = await this.callLLM(topic, goal, language, style, numDays, numModules);
    const course = await this.saveToDB(courseData, organizationId, language);

    logger.info(`✅ Course saved: ${course.id} — "${course.title}"`);
    return course;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Slug-based dedup: normalise topic → check against existing course titles.
   * Returns the first matching published course, or null.
   */
  private async findExistingCourse(topic: string, organizationId: string): Promise<any> {
    try {
      const db = await getDb();
      const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const { data: courses } = await db.courses.findAll({
        organizationId,
        status: 'published',
        limit: 50,
      });
      return courses.find((c: any) => {
        const courseSlug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        // Match if the slugs share 80%+ of their words
        const topicWords = new Set(slug.split('-').filter((w: string) => w.length > 3));
        const courseWords = courseSlug.split('-').filter((w: string) => w.length > 3);
        if (topicWords.size === 0) return false;
        const overlap = courseWords.filter((w: string) => topicWords.has(w)).length;
        return overlap / topicWords.size >= 0.8;
      }) ?? null;
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
  ): Promise<GeneratedCourse> {
    const goalLine = goal ? `\nLearner's goal: ${goal}` : '';
    const langLine = language !== 'en' ? `\nRespond entirely in language code: ${language}` : '';

    const systemPrompt = `You are an expert curriculum designer creating WhatsApp micro-courses.
Design bite-sized, mobile-friendly modules that a learner can read in 2-3 minutes each.

Rules:
- Use simple, conversational language. Avoid jargon.
- Use \\n\\n to separate paragraphs within module content.
- Each module MUST have exactly ONE quiz question (4 options, one correct answer A/B/C/D).
- Each day MUST have exactly 3 comprehension questions that test understanding across all modules that day.
- NO flashcards — do not include any flashcard fields.
- Respond ONLY with valid JSON. No markdown fences, no commentary.${langLine}`;

    const userPrompt = `Create a ${numDays}-day micro-course about: "${topic}"${goalLine}
Style: ${style}
Each day has exactly ${numModules} modules.

Return this exact JSON structure:
{
  "title": "Course title (max 60 characters)",
  "description": "What learners will gain (2-3 sentences)",
  "days": [
    {
      "dayNumber": 1,
      "modules": [
        {
          "title": "Module title (max 60 characters)",
          "content": "Module body (150-200 words). Use \\n\\n for paragraphs. Use *bold* for key terms.",
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

Ensure comprehensionQuestions has exactly 3 items per day.`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const completion = await llmChat({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
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

  private async saveToDB(
    courseData: GeneratedCourse,
    organizationId: string,
    language: string,
  ): Promise<any> {
    const db = await getDb();

    // 1. Create the course record
    const course = await db.courses.create({
      organizationId,
      title: courseData.title,
      description: courseData.description,
      status: 'published',
      settings: { language, aiGenerated: true, totalDays: courseData.days.length },
    });

    // 2. Flatten days → modules, save each as a lesson row with day_number
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

    return course;
  }
}

export const courseGenerator = new CourseGeneratorService();
