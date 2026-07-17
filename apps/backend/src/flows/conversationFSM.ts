/**
 * Conversation FSM (Finite State Machine)
 *
 * Drives the end-to-end WhatsApp learner journey:
 *   idle → topic_input → goal_input → confirming
 *        → generating → learning → doubt → complete
 *
 * FSM state is persisted in the learner's metadata JSONB column:
 *   learner.metadata.fsm = { state, data }
 */

import { logger } from '../lib/logger.js';
import { sm2Review, labelToQuality } from '../lib/fsrs.js';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const getDb = () => import('@ekatra/database').then((m) => m.db);
const getQuery = () => import('@ekatra/database').then((m) => m.query);
const getMessaging = () => import('@ekatra/messaging').then((m) => m.messaging);

// ── State types ────────────────────────────────────────────────────────────

export type FSMState =
  | 'idle'
  | 'language_input'
  | 'style_input'
  | 'topic_input'
  | 'goal_input'
  | 'confirming'
  | 'generating'
  | 'learning'
  | 'doubt'
  | 'review_flashcard'
  | 'complete';

export interface FSMData {
  topic?: string;
  goal?: string;
  language?: string;
  style?: string;
  courseId?: string;
  enrollmentId?: string;
  // Review session state (populated when entering review_flashcard)
  reviewCardIds?: string[];   // ordered list of due flashcard IDs
  reviewCardIndex?: number;   // current position in reviewCardIds
  reviewStep?: 'front' | 'back'; // which side is currently shown
}

export interface FSMContext {
  state: FSMState;
  data: FSMData;
  /** Incremented on every transition. Used for optimistic locking to prevent
   * concurrent message handlers from corrupting state. */
  version: number;
}

interface IncomingMessage {
  from: string;
  name?: string;
  type: string;
  text?: string;
  buttonPayload?: string;
  listReplyId?: string;
  buttonReplyId?: string;
  mediaId?: string;
}

// ── FSM core ───────────────────────────────────────────────────────────────

export class ConversationFSM {
  private courseDelivery: any = null;
  private qaService: any = null;
  private courseGenerator: any = null;

  private async getCourseDelivery() {
    if (!this.courseDelivery) {
      const { CourseDeliveryService } = await import('../services/courseDelivery.js');
      this.courseDelivery = new CourseDeliveryService();
    }
    return this.courseDelivery;
  }

  private async getQAService() {
    if (!this.qaService) {
      const { QAService } = await import('../services/qaService.js');
      this.qaService = new QAService();
    }
    return this.qaService;
  }

  private async getGeneratorService() {
    if (!this.courseGenerator) {
      const { courseGenerator } = await import('../services/courseGenerator.js');
      this.courseGenerator = courseGenerator;
    }
    return this.courseGenerator;
  }

  /**
   * Main entry point — processes one inbound message for a learner.
   */
  async process(learner: any, message: IncomingMessage): Promise<void> {
    // ── Dynamic FSM engine: activates when enrollment has fsm_definition_id ─
    try {
      const db = await getDb();
      const enrollment = await db.enrollments.findActiveByLearner(learner.id);
      if (enrollment?.fsm_definition_id) {
        await this.processDynamic(learner, enrollment, message);
        return;
      }
    } catch (dynErr) {
      logger.error('Dynamic FSM lookup failed, falling back to hardcoded engine:', dynErr);
    }
    // ── Hardcoded engine (fallback for existing learners) ─────────────────
    const ctx = this.getContext(learner);
    let input = (
      message.text ||
      message.buttonPayload ||
      message.listReplyId ||
      message.buttonReplyId ||
      ''
    ).trim();

    logger.info(`🔄 FSM [${learner.id}] state=${ctx.state} input="${input.substring(0, 50)}"`);

    // ── Global commands — handled in ANY state ─────────────────────────────
    // Normalise: strip leading/trailing punctuation so "new topic?" → "new topic"
    const lower = input.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim();
    if (lower === 'restart' || lower === 'reset' || lower === 'new topic' || lower === 'start over' || lower === 'new course') {
      await this.transitionTo(learner, ctx, 'idle', {});
      const messaging = await getMessaging();
      await messaging.sendText(learner.phone, {
        text: '🔄 No problem — let\'s start fresh!',
      });
      await this.handleIdle(learner, ctx, message);
      return;
    }
    if (lower === 'help' || lower === 'menu') {
      const messaging = await getMessaging();
      await messaging.sendText(learner.phone, {
        text:
          `📋 *Here\'s what you can do:*\n\n` +
          `• *next* — continue to the next lesson\n` +
          `• *restart* — start your current course over\n` +
          `• *new topic* — pick a different topic\n` +
          `• *review* — review your flashcards\n` +
          `• *help* — show this menu\n\n` +
          `During a lesson, just type any question and I\'ll answer it! 💡`,
      });
      return;
    }
    // Normalise input for all state handlers — strips punctuation + lowercases.
    // Must be after global commands (which need to return early) but before switch.
    input = lower;
    // ──────────────────────────────────────────────────────────────────────

    try {
      switch (ctx.state) {
        case 'idle':
          await this.handleIdle(learner, ctx, message);
          break;
        case 'language_input':
          await this.handleLanguageInput(learner, ctx, input);
          break;
        case 'style_input':
          await this.handleStyleInput(learner, ctx, input);
          break;
        case 'topic_input':
          await this.handleTopicInput(learner, ctx, input);
          break;
        case 'goal_input':
          await this.handleGoalInput(learner, ctx, input);
          break;
        case 'confirming':
          await this.handleConfirming(learner, ctx, input);
          break;
        case 'generating':
          // Generation is async; just acknowledge re-messages
          await this.handleGenerating(learner, ctx);
          break;
        case 'learning':
          await this.handleLearning(learner, ctx, message);
          break;
        case 'doubt':
          await this.handleDoubt(learner, ctx, message, input);
          break;
        case 'review_flashcard':
          await this.handleReviewFlashcard(learner, ctx, input);
          break;
        case 'complete':
          await this.handleComplete(learner, ctx, input);
          break;
        default:
          await this.transitionTo(learner, ctx, 'idle', {});
          await this.handleIdle(learner, ctx, message);
      }
    } catch (err) {
      logger.error('FSM error:', err);
      const messaging = await getMessaging();
      await messaging.sendText(learner.phone, {
        text: 'Sorry, something went wrong. Please try again!',
      });
    }
  }

  // ── State handlers ────────────────────────────────────────────────────────

  private async handleIdle(
    learner: any,
    ctx: FSMContext,
    message: IncomingMessage,
  ): Promise<void> {
    const messaging = await getMessaging();
    const db = await getDb();

    // Check for an existing active enrollment first
    const enrollments = await db.enrollments.findByLearner(learner.id);
    const active = enrollments.find(
      (e: any) => e.status === 'enrolled' || e.status === 'in_progress',
    );

    if (active) {
      // Resume existing course
      await this.transitionTo(learner, ctx, 'learning', {
        courseId: active.course_id,
        enrollmentId: active.id,
      });
      const courseDelivery = await this.getCourseDelivery();
      await courseDelivery.sendNextLesson(learner.phone, active);
      return;
    }

    // New user or no active course — start with language selection
    await this.transitionTo(learner, ctx, 'language_input', {});
    await messaging.sendInteractiveButtons(learner.phone, {
      body: `👋 Welcome to *Ekatra*!\n\nA brand new way of learning through bite-sized lessons, delivered right here on WhatsApp. 🌍\n\nYou're part of an exclusive group with this access!\n\nWhat language would you like to learn in?`,
      buttons: [
        { id: 'lang_en', title: 'English' },
        { id: 'lang_hi', title: 'हिंदी' },
        { id: 'lang_es', title: 'Español' },
      ],
    });
  }

  private async handleLanguageInput(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();
    const db = await getDb();

    const langMap: Record<string, string> = {
      lang_en: 'en',
      lang_hi: 'hi',
      lang_es: 'es',
      english: 'en',
      hindi: 'hi',
      'हिंदी': 'hi',
      español: 'es',
      spanish: 'es',
    };

    const lang = langMap[input.toLowerCase()] ?? 'en';
    ctx.data.language = lang;

    // Persist language preference directly on the learner record
    await db.learners.update(learner.id, { language: lang });
    learner.language = lang;

    await this.transitionTo(learner, ctx, 'style_input', ctx.data);

    const isHindi = lang === 'hi';
    await messaging.sendInteractiveButtons(learner.phone, {
      body: isHindi
        ? `बढ़िया! 🤩\n\nमैं *Alfred* हूँ — आपका AI टीचर, जो किसी भी विषय पर कोर्स बना सकता है।\n\nआप किस तरह से सीखना पसंद करते हैं?`
        : `That's amazing! 🤩\n\nI'm *Alfred*, your AI tutor — I can create a course on any topic you choose.\n\nHow do you prefer to learn?`,
      buttons: [
        { id: 'style_professional', title: isHindi ? 'औपचारिक' : 'Professional' },
        { id: 'style_casual', title: isHindi ? 'आसान भाषा' : 'Casual' },
        { id: 'style_practical', title: isHindi ? 'व्यावहारिक' : 'Practical' },
      ],
    });
  }

  private async handleStyleInput(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();

    const styleMap: Record<string, string> = {
      style_professional: 'professional',
      style_casual: 'casual',
      style_practical: 'practical',
      professional: 'professional',
      casual: 'casual',
      practical: 'practical',
      'औपचारिक': 'professional',
      'आसान भाषा': 'casual',
      'व्यावहारिक': 'practical',
    };

    const resolvedStyle = styleMap[input.toLowerCase()];
    if (!resolvedStyle) {
      await messaging.sendInteractiveButtons(learner.phone, {
        body: `Please choose a learning style to continue:`,
        buttons: [
          { id: 'style_professional', title: 'Professional' },
          { id: 'style_casual', title: 'Casual' },
          { id: 'style_practical', title: 'Practical' },
        ],
      });
      return;
    }

    ctx.data.style = resolvedStyle;
    await this.transitionTo(learner, ctx, 'topic_input', ctx.data);

    const isHindi = ctx.data.language === 'hi';
    await messaging.sendText(learner.phone, {
      text: isHindi
        ? `अच्छा! 📚\n\nआप क्या सीखना चाहते हैं? (उदाहरण: "Python basics" या "शेयर मार्केट की बेसिक्स")`
        : `Perfect! 📚\n\nWhat would you like to learn?\n\n_Example: "Python basics" or "Marketing fundamentals"_`,
    });
  }

  private async handleTopicInput(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();

    if (!input || input.length < 2) {
      await messaging.sendText(learner.phone, {
        text: "Please type what you'd like to learn. For example: *Python basics*",
      });
      return;
    }

    ctx.data.topic = input;
    await this.transitionTo(learner, ctx, 'goal_input', ctx.data);

    await messaging.sendInteractiveButtons(learner.phone, {
      body: `Great choice! 📚 *${input}*\n\nWhat's your main goal with this topic?`,
      buttons: [
        { id: 'goal_beginner', title: 'Complete beginner' },
        { id: 'goal_refresh', title: 'Quick refresher' },
        { id: 'goal_practical', title: 'Practical skills' },
      ],
    });
  }

  private async handleGoalInput(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();

    const goalMap: Record<string, string> = {
      goal_beginner: 'I am a complete beginner',
      goal_refresh: 'Quick refresher of the basics',
      goal_practical: 'Focus on practical, real-world skills',
      'complete beginner': 'I am a complete beginner',
      beginner: 'I am a complete beginner',
      'quick refresher': 'Quick refresher of the basics',
      refresher: 'Quick refresher of the basics',
      practical: 'Focus on practical, real-world skills',
    };

    ctx.data.goal = goalMap[input] || input;
    await this.transitionTo(learner, ctx, 'confirming', ctx.data);

    const { topic, goal, style, language } = ctx.data;
    const isHindi = language === 'hi';
    const styleLabelMap: Record<string, string> = {
      professional: 'Professional',
      casual: 'Casual & conversational',
      practical: 'Practical & hands-on',
    };
    const styleLabel = styleLabelMap[style || 'casual'] || style || 'Casual';

    await messaging.sendInteractiveButtons(learner.phone, {
      body: isHindi
        ? `✅ *आपका लर्निंग प्लान:*\n\n📌 *विषय:* ${topic}\n🎯 *लक्ष्य:* ${goal}\n✍️ *शैली:* ${styleLabel}\n📚 *5 छोटे पाठ*, हर एक ~3 मिनट\n\nक्या Alfred इसे आपके लिए बनाए?`
        : `✅ *Here's your learning plan:*\n\n📌 *Topic:* ${topic}\n🎯 *Goal:* ${goal}\n✍️ *Style:* ${styleLabel}\n📚 *5 bite-sized lessons*, each ~3 min\n✨ *Includes:* Explanations, quizzes & flashcards\n\nShall Alfred generate this course for you?`,
      buttons: [
        { id: 'confirm_yes', title: isHindi ? 'हाँ, शुरू करें!' : 'Yes, start!' },
        { id: 'confirm_change', title: isHindi ? 'विषय बदलें' : 'Change topic' },
      ],
    });
  }

  private async handleConfirming(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();

    if (input === 'confirm_change' || input.toLowerCase().includes('change')) {
      await this.transitionTo(learner, ctx, 'topic_input', {});
      await messaging.sendText(learner.phone, {
        text: 'No problem! What topic would you like to learn instead?',
      });
      return;
    }

    // Confirmed → kick off async course generation
    await this.transitionTo(learner, ctx, 'generating', ctx.data);
    const firstName = (learner.name || '').split(' ')[0];
    const nameStr = firstName ? `, ${firstName}` : '';
    await messaging.sendText(learner.phone, {
      text: `🔄 Alfred is generating your personalised *${ctx.data.topic}* course${nameStr}...\n\nThis takes about 30 seconds. I'll message you when it's ready! ✨`,
    });

    // Generate in background (don't await in the webhook response).
    // A 90-second hard timeout ensures the learner is never stuck in `generating`
    // indefinitely if the LLM hangs without throwing.
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Course generation timed out after ${ms / 1000}s`)), ms),
      );
      return Promise.race([p, timeout]);
    };

    withTimeout(this.generateCourseAsync(learner, ctx.data), 90_000).catch(async (err) => {
      logger.error('Async course generation failed (outer catch):', err);
      try {
        const db = await getDb();
        const messaging = await getMessaging();
        const freshLearner = await db.learners.findById(learner.id);
        if (freshLearner) {
          const freshCtx = this.getContext(freshLearner);
          if (freshCtx.state === 'generating') {
            await this.transitionTo(freshLearner, freshCtx, 'topic_input', {});
          }
        }
        await messaging.sendText(learner.phone, {
          text: `😔 I'm having trouble generating your course right now. Please try again — just type the topic you'd like to learn!`,
        });
      } catch (recoveryErr) {
        logger.error('Failed to recover from generation timeout:', recoveryErr);
      }
    });
  }

  private async handleGenerating(learner: any, ctx: FSMContext): Promise<void> {
    const messaging = await getMessaging();
    await messaging.sendText(learner.phone, {
      text: '⏳ Still generating your course, please wait a moment...',
    });
  }

  private async handleLearning(
    learner: any,
    ctx: FSMContext,
    message: IncomingMessage,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();
    const courseDelivery = await this.getCourseDelivery();

    const input = (
      message.text ||
      message.buttonPayload ||
      message.buttonReplyId ||
      message.listReplyId ||
      ''
    )
      .toLowerCase()
      .trim();

    const enrollmentId = ctx.data.enrollmentId;
    if (!enrollmentId) {
      await this.transitionTo(learner, ctx, 'idle', {});
      return;
    }

    const enrollment = await db.enrollments.findById(enrollmentId);
    if (!enrollment) {
      await this.transitionTo(learner, ctx, 'idle', {});
      return;
    }

    // Route learning interactions
    if (input === 'start_lesson' || input === 'start lesson') {
      // Daily reminder re-entry — v2-style: check lesson progress and deliver correctly
      const freshEnrollment = await db.enrollments.findById(enrollmentId);
      if (freshEnrollment?.current_lesson_id) {
        const progress = await db.lessonProgress.find(freshEnrollment.id, freshEnrollment.current_lesson_id);
        if (!progress) {
          // Lesson never delivered — send it fresh
          await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
        } else if (progress.status === 'completed') {
          // Lesson already done but pointer not advanced — call markLessonComplete to advance
          const currentLessonCheck = await db.lessons.findById(freshEnrollment.current_lesson_id);
          if (currentLessonCheck?.content_type === 'review') {
            await courseDelivery.markDayReviewComplete(freshEnrollment.id, freshEnrollment.current_lesson_id);
          } else {
            await courseDelivery.markLessonComplete(freshEnrollment.id, freshEnrollment.current_lesson_id);
          }
        } else {
          // Lesson was started (delivered) but not answered — show Continue/Restart choice
          await messaging.sendInteractiveButtons(learner.phone, {
            body: `📚 You\'re partway through this module. Ready to continue?`,
            buttons: [
              { id: 'next', title: 'Continue' },
              { id: 'start_lesson_restart', title: 'Restart Module' },
            ],
          });
        }
      } else {
        await courseDelivery.sendNextLesson(learner.phone, freshEnrollment ?? enrollment);
      }
    } else if (input === 'start_lesson_restart') {
      // Learner chose to re-deliver the current module from the top
      const freshEnrollment = await db.enrollments.findById(enrollmentId);
      if (freshEnrollment) {
        await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
      }
    } else if (input === 'ask_question' || input === 'ask' || input === 'ask question' || input === 'ask a question') {
      await this.transitionTo(learner, ctx, 'doubt', ctx.data);
      await messaging.sendText(learner.phone, {
        text: "❓ What's your question? I'll help you understand it!",
      });
    } else if (input === 'review_flashcards' || input === 'review' || input.startsWith('review cards') || input.startsWith('review ')) {
      await this.startFlashcardReview(learner, ctx);
    } else if (input === 'doubt_yes') {
      // User tapped "Yes, I have a doubt" from day-end prompt
      await this.transitionTo(learner, ctx, 'doubt', ctx.data);
      await messaging.sendText(learner.phone, {
        text: "❓ Go ahead — what's your question about today's lesson?",
      });
    } else if (input === 'doubt_no') {
      // User tapped "No, all good!" from day-end prompt — close out the day
      await messaging.sendText(learner.phone, {
        text: `Great! See you tomorrow for the next day of learning! 🌟\n\nCome back anytime to continue. Just say *hi* to pick up where you left off. 💪`,
      });
    } else if (input === 'hi' || input === 'hello' || input === 'hey') {
      // Greeting — show current progress
      const enrollment2 = await db.enrollments.findById(enrollmentId);
      if (enrollment2?.current_lesson_id) {
        const currentLesson = await db.lessons.findById(enrollment2.current_lesson_id);
        const allLessons = await db.lessons.findByCourse(enrollment2.course_id);
        const regularLessons = allLessons.filter((l: any) => l.content_type !== 'review');
        const dayNum = currentLesson?.day_number ?? 1;
        const totalDays = Math.max(...regularLessons.map((l: any) => l.day_number ?? 1), 1);
        const lessonsInDay = regularLessons.filter((l: any) => (l.day_number ?? 1) === dayNum);
        const moduleInDay = lessonsInDay.findIndex((l: any) => l.id === currentLesson?.id) + 1;
        await messaging.sendInteractiveButtons(learner.phone, {
          body: `👋 Welcome back! You're on *Day ${dayNum}/${totalDays}, Module ${moduleInDay}/${lessonsInDay.length}*.\n\nReady to continue?`,
          buttons: [
            { id: 'next', title: 'Continue' },
            { id: 'ask_question', title: 'Ask a Question' },
          ],
        });
      } else {
        await messaging.sendText(learner.phone, { text: "👋 Welcome back! Tap *continue* to pick up where you left off." });
      }
    } else if (input === 'restart' || input === 'start over' || input === 'reset') {
      // Reset enrollment to first lesson
      const allLessons = await db.lessons.findByCourse(enrollment.course_id);
      const firstLesson = allLessons.find((l: any) => l.content_type !== 'review');
      if (firstLesson) {
        await db.enrollments.update(enrollmentId, {
          currentLessonId: firstLesson.id,
          progress: 0,
          status: 'in_progress',
        });
        await messaging.sendText(learner.phone, {
          text: "🔄 Restarting from Day 1, Module 1. Let's go! 🚀",
        });
        await delay(2000);
        const freshEnrollment = await db.enrollments.findById(enrollmentId);
        if (freshEnrollment) {
          await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
        }
      }
    } else if (input === 'next' || input === 'continue' || input === 'start_day' || input === 'start now' || input === 'next lesson' || input === 'next →' || input === 'next module' || input === '1') {
      if (enrollment.current_lesson_id) {
        // If current lesson is a review (day-end comprehension), route to markDayReviewComplete
        // so the doubt loop fires. Otherwise use the normal markLessonComplete path.
        const currentLessonForNext = await db.lessons.findById(enrollment.current_lesson_id);
        if (currentLessonForNext?.content_type === 'review') {
          await courseDelivery.markDayReviewComplete(enrollment.id, enrollment.current_lesson_id);
        } else {
          await courseDelivery.markLessonComplete(enrollment.id, enrollment.current_lesson_id);
        }
        // If enrollment is now complete, transition FSM to complete state
        const refreshed = await db.enrollments.findById(enrollment.id);
        if (refreshed?.status === 'completed') {
          await this.transitionTo(learner, ctx, 'complete', {});
        }
      } else {
        await courseDelivery.sendNextLesson(learner.phone, enrollment);
      }
    } else if (input.startsWith('quiz_')) {
      await this.handleQuizResponse(learner, enrollment, input, ctx);
    } else if (/^[a-d]$/.test(input)) {
      // Content API quick-reply tap: user picked quiz option A/B/C/D
      const questions = await db.quiz.findByLesson(enrollment.current_lesson_id);
      if (questions.length > 0) {
        await this.handleQuizResponse(learner, enrollment, `quiz_${questions[0].id}_${input.toUpperCase()}`, ctx);
      } else {
        if (enrollment.current_lesson_id) {
          await courseDelivery.markLessonComplete(enrollment.id, enrollment.current_lesson_id);
          const refreshed = await db.enrollments.findById(enrollment.id);
          if (refreshed?.status === 'completed') {
            await this.transitionTo(learner, ctx, 'complete', {});
          }
        } else {
          await courseDelivery.sendNextLesson(learner.phone, enrollment);
        }
      }
    } else if (input === 'menu' || input === 'courses') {
      await this.transitionTo(learner, ctx, 'idle', {});
    } else {
      // Check if there are due flashcards to surface them
      const dueCount = await db.flashcardProgress.countDueForLearner(learner.id);
      const buttons: Array<{ id: string; title: string }> = [
        { id: 'next', title: 'Next Lesson' },
        { id: 'ask_question', title: 'Ask Question' },
      ];
      if (dueCount > 0) {
        buttons.push({ id: 'review_flashcards', title: `Review Cards (${dueCount})` });
      }
      await messaging.sendInteractiveButtons(learner.phone, {
        body: `Ready to continue? 📖${dueCount > 0 ? `\n\n🃏 You have *${dueCount}* flashcard${dueCount !== 1 ? 's' : ''} due for review!` : ''}`,
        buttons,
      });
    }
  }

  private async handleDoubt(
    learner: any,
    ctx: FSMContext,
    message: IncomingMessage,
    input: string,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    if (input === 'next' || input === 'continue' || input === 'next_lesson' || input === 'next lesson') {
      // Exit doubt state → resume learning
      await this.transitionTo(learner, ctx, 'learning', ctx.data);
      const enrollment = await db.enrollments.findById(ctx.data.enrollmentId!);
      if (enrollment) {
        const courseDelivery = await this.getCourseDelivery();
        await courseDelivery.sendNextLesson(learner.phone, enrollment);
      }
      return;
    }

    // "no" / "no more" / "nope" closes the doubt loop
    if (input === 'no' || input === 'no more' || input === 'nope' || input === 'done' || input === 'no doubt') {
      await this.transitionTo(learner, ctx, 'learning', ctx.data);
      await messaging.sendText(learner.phone, {
        text: `Great! See you tomorrow for the next day of learning! 🌟\n\nCome back anytime — just say *hi* to continue. 💪`,
      });
      return;
    }

    if (!input || input.length < 3) {
      await messaging.sendText(learner.phone, {
        text: "Please type your question and I'll help you!",
      });
      return;
    }

    // doubt_yes from the loop prompt — just prompt them to type their question
    if (input === 'doubt_yes' || input === 'yes, another question') {
      await messaging.sendText(learner.phone, {
        text: "❓ Go ahead — type your question!",
      });
      return;
    }

    const qaService = await this.getQAService();
    const enrollment = await db.enrollments.findById(ctx.data.enrollmentId!);
    await qaService.handleTextQuestion(learner, enrollment, input);

    // After answering, loop — ask if there are more doubts
    await messaging.sendInteractiveButtons(learner.phone, {
      body: 'Any other doubts? 🤔',
      buttons: [
        { id: 'doubt_yes', title: 'Yes, another question' },
        { id: 'no', title: 'No, all good!' },
      ],
    });
  }

  // ── Flashcard review ─────────────────────────────────────────────────────

  /**
   * Kick off a flashcard review session from the learning state.
   * Fetches due cards and transitions to review_flashcard.
   */
  private async startFlashcardReview(learner: any, ctx: FSMContext): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    const dueCards = await db.flashcardProgress.findDueForLearner(learner.id);

    if (dueCards.length === 0) {
      await messaging.sendText(learner.phone, {
        text: "✅ No flashcards due right now — you're all caught up! Come back tomorrow.",
      });
      return;
    }

    const cardIds = dueCards.map((c: any) => c.flashcard_id);
    await this.transitionTo(learner, ctx, 'review_flashcard', {
      ...ctx.data,
      reviewCardIds: cardIds,
      reviewCardIndex: 0,
      reviewStep: 'front',
    });

    await messaging.sendText(learner.phone, {
      text: `🃏 *Flashcard Review* — ${dueCards.length} card${dueCards.length !== 1 ? 's' : ''} due\n\nI'll show you each card. Try to recall the answer before revealing it!`,
    });

    await this.showFlashcardFront(learner, dueCards[0]);
  }

  /**
   * Handle all inputs while in review_flashcard state.
   * States within a card: front → back → (rating) → next card or done.
   */
  private async handleReviewFlashcard(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    const cardIds = ctx.data.reviewCardIds ?? [];
    const index = ctx.data.reviewCardIndex ?? 0;

    // Allow learner to exit review mid-session
    if (input === 'exit_review' || input === 'next' || input === 'stop_review' || input === 'stop review' || input === 'next lesson') {
      await this.transitionTo(learner, ctx, 'learning', {
        courseId: ctx.data.courseId,
        enrollmentId: ctx.data.enrollmentId,
      });
      await messaging.sendInteractiveButtons(learner.phone, {
        body: '👋 Review paused. Keep up the great work!',
        buttons: [
          { id: 'next', title: 'Next Lesson' },
          { id: 'ask_question', title: 'Ask Question' },
        ],
      });
      return;
    }

    if (ctx.data.reviewStep === 'front') {
      // Learner tapped "Reveal Answer"
      if (input === 'reveal' || input === 'reveal answer') {
        const progress = await db.flashcardProgress.findDueForLearner(learner.id);
        const card = progress.find((c: any) => c.flashcard_id === cardIds[index])
          || { flashcard_id: cardIds[index], front: '', back: '' };

        // Fetch the flashcard if not in progress result
        let flashcard = card;
        if (!card.back) {
          const results = await db.flashcards.findByLessons([]);
          // Fallback: raw query for single flashcard
          const raw = await db.raw(
            'SELECT * FROM flashcards WHERE id = $1',
            [cardIds[index]]
          );
          flashcard = raw.rows[0] || card;
        } else {
          flashcard = card;
        }

        await this.transitionTo(learner, ctx, 'review_flashcard', {
          ...ctx.data,
          reviewStep: 'back',
        });

        await messaging.sendInteractiveButtons(learner.phone, {
          body: `💡 *Answer:*\n${flashcard.back}`,
          buttons: [
            { id: 'rating_easy', title: '😊 Easy' },
            { id: 'rating_hard', title: '😐 Hard' },
            { id: 'rating_forgot', title: '😓 Forgot' },
          ],
        });
      } else {
        // Re-show the current front
        const raw = await db.raw('SELECT * FROM flashcards WHERE id = $1', [cardIds[index]]);
        if (raw.rows[0]) await this.showFlashcardFront(learner, { front: raw.rows[0].front, flashcard_id: cardIds[index] });
      }
      return;
    }

    // reviewStep === 'back' — learner is rating the card
    // Accept both button IDs (rating_easy) and button title text (😊 easy, easy, hard, forgot)
    if (input.startsWith('rating_') || input.includes('easy') || input.includes('hard') || input.includes('forgot')) {
      const quality = labelToQuality(input);
      const progressRow = await db.flashcardProgress.find(learner.id, cardIds[index]);

      if (progressRow) {
        const result = sm2Review({
          quality,
          interval: progressRow.interval_days ?? 1,
          easeFactor: parseFloat(progressRow.ease_factor ?? '2.5'),
          reps: progressRow.reps ?? 0,
          lapses: progressRow.lapses ?? 0,
        });

        await db.flashcardProgress.updateById(progressRow.id, {
          intervalDays: result.interval,
          easeFactor: result.easeFactor,
          reps: result.reps,
          lapses: result.lapses,
          dueDate: result.dueDate,
          lastReviewAt: new Date(),
        });
      }

      // Advance to next card
      const nextIndex = index + 1;
      if (nextIndex >= cardIds.length) {
        // Review complete
        await this.transitionTo(learner, ctx, 'learning', {
          courseId: ctx.data.courseId,
          enrollmentId: ctx.data.enrollmentId,
        });
        await messaging.sendInteractiveButtons(learner.phone, {
          body: `🎉 *Review complete!* You reviewed ${cardIds.length} card${cardIds.length !== 1 ? 's' : ''}.\n\nKeep up the great work — your memory is getting stronger!`,
          buttons: [
            { id: 'next', title: 'Next Lesson' },
            { id: 'ask_question', title: 'Ask Question' },
          ],
        });
      } else {
        // Show next card front
        await this.transitionTo(learner, ctx, 'review_flashcard', {
          ...ctx.data,
          reviewCardIndex: nextIndex,
          reviewStep: 'front',
        });

        const raw = await db.raw('SELECT * FROM flashcards WHERE id = $1', [cardIds[nextIndex]]);
        if (raw.rows[0]) {
          await messaging.sendText(learner.phone, {
            text: `📊 Card ${nextIndex + 1}/${cardIds.length}`,
          });
          await this.showFlashcardFront(learner, {
            front: raw.rows[0].front,
            flashcard_id: cardIds[nextIndex],
          });
        }
      }
    }
  }

  /** Show the front of a flashcard with a Reveal Answer button. */
  private async showFlashcardFront(learner: any, card: { front: string; flashcard_id?: string }): Promise<void> {
    const messaging = await getMessaging();
    await messaging.sendInteractiveButtons(learner.phone, {
      body: `🃏 *Front:*\n${card.front}`,
      buttons: [
        { id: 'reveal', title: 'Reveal Answer' },
        { id: 'exit_review', title: 'Stop Review' },
      ],
    });
  }

  private async handleComplete(
    learner: any,
    ctx: FSMContext,
    input: string,
  ): Promise<void> {
    const messaging = await getMessaging();

    if (input === 'new_course' || input === 'start_new' || input === 'learn something new') {
      await this.transitionTo(learner, ctx, 'topic_input', {});
      await messaging.sendText(learner.phone, {
        text: "Excellent! 🚀 What would you like to learn next?",
      });
      return;
    }

    // Daily flashcard reminder taps "Start Lesson" / "review_flashcards" while FSM
    // is in complete state — route them into flashcard review rather than looping.
    if (
      input === 'start_lesson' ||
      input === 'review_flashcards' ||
      input === 'review' ||
      input.startsWith('review cards') ||
      input.startsWith('review ')
    ) {
      await this.startFlashcardReview(learner, ctx);
      return;
    }

    const db = await getDb();
    const dueCount = await db.flashcardProgress.countDueForLearner(learner.id);

    const buttons: Array<{ id: string; title: string }> = [
      { id: 'new_course', title: 'Learn Something New' },
    ];
    if (dueCount > 0) {
      buttons.push({ id: 'review_flashcards', title: `Review Cards (${dueCount})` });
    }

    await messaging.sendInteractiveButtons(learner.phone, {
      body: `🎓 You've completed your course! Excellent work!${dueCount > 0 ? `\n\n🃏 You have *${dueCount}* flashcard${dueCount !== 1 ? 's' : ''} due for review.` : ''}\n\nWhat would you like to do next?`,
      buttons,
    });
  }

  // ── Course generation (async) ─────────────────────────────────────────────

  private async generateCourseAsync(learner: any, data: FSMData): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    try {
      const generator = await this.getGeneratorService();
      const org = await db.organizations.getDefault();

      const course = await generator.generate({
        topic: data.topic!,
        goal: data.goal,
        language: data.language || learner.language || 'en',
        style: data.style || 'casual',
        organizationId: org?.id || learner.organization_id,
      });

      // Enroll the learner
      const lessons = await db.lessons.findByCourse(course.id);
      const firstLesson = lessons[0];

      const enrollment = await db.enrollments.create({
        learnerId: learner.id,
        courseId: course.id,
        status: 'in_progress',
      });

      if (firstLesson) {
        await db.enrollments.update(enrollment.id, {
          currentLessonId: firstLesson.id,
        });
      }

      // Enqueue all flashcards from this course as due for the learner
      const lessonIds = lessons.map((l: any) => l.id);
      const enqueued = await db.flashcardProgress.enqueueForLearner(learner.id, lessonIds);
      if (enqueued) logger.info(`🃏 Enqueued ${enqueued} flashcards for learner ${learner.id}`);

      // Transition to learning
      const freshLearner = await db.learners.findById(learner.id);
      const freshCtx = this.getContext(freshLearner);
      await this.transitionTo(freshLearner, freshCtx, 'learning', {
        courseId: course.id,
        enrollmentId: enrollment.id,
        topic: data.topic,
        goal: data.goal,
        language: data.language,
        style: data.style,
      });

      // Notify learner
      await messaging.sendText(learner.phone, {
        text: `✅ Your course *${course.title}* is ready!\n\nIt has ${lessons.length} lessons. Let's start your first one! 🚀`,
      });

      // Send the first lesson immediately — use the enrollment we just created
      const courseDelivery = await this.getDeliveryService();
      const freshEnrollment = await db.enrollments.findById(enrollment.id);
      await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
    } catch (err: any) {
      logger.error('Background course generation failed:', err);

      // Reset state so the user can try again
      const freshLearner = await db.learners.findById(learner.id);
      const freshCtx = this.getContext(freshLearner);
      await this.transitionTo(freshLearner, freshCtx, 'topic_input', {});

      // Give a hint if it's a connectivity problem (helps during dev)
      const isConnError =
        err?.code === 'ENOTFOUND' ||
        err?.code === 'ECONNREFUSED' ||
        err?.message?.toLowerCase().includes('connection error');

      await messaging.sendText(learner.phone, {
        text: isConnError
          ? "😔 I'm having trouble reaching the AI service right now. Please try again in a few minutes — type the topic you want to learn!"
          : "😔 Sorry, I had trouble generating your course. Please try again — type the topic you want to learn!",
      });
    }
  }

  // ── Quiz response handler ─────────────────────────────────────────────────

  private async handleQuizResponse(
    learner: any,
    enrollment: any,
    response: string,
    ctx: FSMContext,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();
    const courseDelivery = await this.getCourseDelivery();

    // Format: "quiz_<questionId>_<answer>"  e.g. "quiz_abc123_A"
    const parts = response.split('_');
    if (parts.length < 3) return;

    const questionId = parts[1];
    const answer = parts[2].toUpperCase();

    const questions = await db.quiz.findByLesson(enrollment.current_lesson_id);
    const question = questions.find((q: any) => q.id === questionId);

    if (!question) {
      await courseDelivery.sendNextLesson(learner.phone, enrollment);
      return;
    }

    const isCorrect = question.correct_answer === answer;
    await db.quiz.saveResponse({ learnerId: learner.id, questionId, answer, isCorrect });

    const feedback = isCorrect
      ? `✅ *Correct!*\n\n${question.explanation || 'Well done!'}`
      : `❌ *Not quite.* The answer was *${question.correct_answer}*.\n\n${question.explanation || ''}`;

    await messaging.sendText(learner.phone, { text: feedback });

    // Brief pause then prompt for next module
    await messaging.sendInteractiveButtons(learner.phone, {
      body: isCorrect ? "🎉 Great work! Let's keep the momentum going!" : "📖 Every question makes you sharper — keep going!",
      buttons: [
        { id: 'next', title: 'Next Module' },
        { id: 'ask_question', title: 'Ask a Question' },
      ],
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // ── Dynamic FSM engine ────────────────────────────────────────────────────
  // Drives learners enrolled in a course with an fsm_definition_id.
  // State is stored in learner.metadata.fsm_dynamic (separate from hardcoded engine's fsm key).

  private async processDynamic(learner: any, enrollment: any, message: IncomingMessage): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    const normalizedInput = (
      message.text ||
      message.buttonPayload ||
      message.listReplyId ||
      message.buttonReplyId ||
      ''
    ).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim();

    logger.info(`⚡ Dynamic FSM [${learner.id}] input="${normalizedInput.substring(0, 50)}" fsm=${enrollment.fsm_definition_id}`);

    // Load FSM definition
    let fsmDef: any;
    try {
      fsmDef = await db.fsmDefinitions.findById(enrollment.fsm_definition_id);
    } catch (_e) {
      fsmDef = null;
    }

    if (!fsmDef || !fsmDef.fsm_json) {
      logger.error(`Dynamic FSM: definition ${enrollment.fsm_definition_id} missing or invalid`);
      await messaging.sendText(learner.phone, { text: 'Something went wrong. Reply *menu* to continue.' });
      return;
    }

    const fsmJson = fsmDef.fsm_json as { states: any[]; transitions: any[] };
    const states: any[] = fsmJson.states ?? [];
    const transitions: any[] = fsmJson.transitions ?? [];

    // Resolve current state — default to the start node
    const startNode = states.find((s) => s.type === 'start') ?? states[0];
    const currentStateId: string = learner.metadata?.fsm_dynamic?.state ?? startNode?.id;

    if (!currentStateId) {
      logger.error(`Dynamic FSM: no start node in definition ${enrollment.fsm_definition_id}`);
      await messaging.sendText(learner.phone, { text: 'Something went wrong. Reply *menu* to continue.' });
      return;
    }

    // Find matching transition
    const transition = transitions.find(
      (t) =>
        t.from === currentStateId &&
        (t.trigger ?? '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim() === normalizedInput
    );

    if (!transition) {
      logger.info(`Dynamic FSM [${learner.id}]: no transition from "${currentStateId}" on "${normalizedInput}"`);
      await messaging.sendText(learner.phone, { text: 'Something went wrong. Reply *menu* to continue.' });
      return;
    }

    const targetNode = states.find((s) => s.id === transition.to);
    if (!targetNode) {
      logger.error(`Dynamic FSM: target node "${transition.to}" not found in definition ${enrollment.fsm_definition_id}`);
      await messaging.sendText(learner.phone, { text: 'Something went wrong. Reply *menu* to continue.' });
      return;
    }

    // Execute node action
    try {
      if (targetNode.type === 'lesson') {
        const delivery = await this.getCourseDelivery();
        await delivery.sendNextLesson(learner.phone, enrollment);
      } else if (targetNode.type === 'question') {
        const delivery = await this.getCourseDelivery();
        await delivery.runDayEndReview?.(learner, enrollment);
      } else if (targetNode.type === 'end') {
        await db.enrollments.update(enrollment.id, { status: 'completed' });
        await messaging.sendText(learner.phone, {
          text: '🎉 You have completed this course! Well done.',
        });
      } else {
        // start / unknown — just acknowledge
        await messaging.sendText(learner.phone, { text: 'Welcome! Type the trigger word to begin.' });
      }
    } catch (actionErr) {
      logger.error(`Dynamic FSM: action error for node "${targetNode.id}":`, actionErr);
      await messaging.sendText(learner.phone, { text: 'Something went wrong. Reply *menu* to continue.' });
      return;
    }

    // Persist new state using optimistic lock on fsm_dynamic version
    const currentVersion: number = learner.metadata?.fsm_dynamic?.version ?? 0;
    const newDynamicCtx = { state: transition.to, version: currentVersion + 1 };

    const updated = await (await getQuery())(
      `UPDATE learners
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{fsm_dynamic}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2
         AND (metadata->'fsm_dynamic'->>'version' IS NULL OR (metadata->'fsm_dynamic'->>'version')::int = $3)
       RETURNING id`,
      [JSON.stringify(newDynamicCtx), learner.id, currentVersion]
    );

    if (!updated?.rows?.length) {
      logger.warn(`⚠️  Dynamic FSM optimistic lock conflict for learner ${learner.id} — state update skipped`);
    } else {
      logger.info(`⚡ Dynamic FSM [${learner.id}] → ${transition.to} (v${newDynamicCtx.version})`);
    }
  }

  private getContext(learner: any): FSMContext {
    const stored = learner?.metadata?.fsm;
    return stored ?? { state: 'idle', data: {}, version: 0 };
  }

  private async transitionTo(
    learner: any,
    ctx: FSMContext,
    newState: FSMState,
    data: FSMData,
  ): Promise<void> {
    const expectedVersion = ctx.version ?? 0;
    const newCtx: FSMContext = {
      state: newState,
      data,
      version: expectedVersion + 1,
    };

    const db = await getDb();

    // Optimistic locking with retry: retry up to 2 times (200ms apart) if a
    // concurrent handler already incremented the version under us.
    let result = await db.learners.updateFSM(learner.id, newCtx, expectedVersion);
    if (!result) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const fresh = await db.learners.findById(learner.id);
        const freshCtx: FSMContext = fresh?.metadata?.fsm ?? { state: 'idle', data: {}, version: 0 };
        const retryCtx: FSMContext = {
          state: newState,
          data,
          version: (freshCtx.version ?? 0) + 1,
        };
        result = await db.learners.updateFSM(learner.id, retryCtx, freshCtx.version ?? 0);
        if (result) {
          logger.info(`🔄 FSM transition [${learner.id}] → ${newState} (v${retryCtx.version}) after ${attempt} retry`);
          ctx.state = retryCtx.state;
          ctx.data = retryCtx.data;
          ctx.version = retryCtx.version;
          learner.metadata = { ...(learner.metadata || {}), fsm: retryCtx };
          return;
        }
      }
      logger.warn(
        `⚠️  FSM optimistic lock conflict for learner ${learner.id} — ` +
        `transition to '${newState}' discarded after 2 retries.`,
      );
      throw new Error(`FSM transition conflict: ${ctx.state} -> ${newState}`);
    }

    // Keep local reference in sync
    ctx.state = newCtx.state;
    ctx.data = newCtx.data;
    ctx.version = newCtx.version;
    learner.metadata = { ...(learner.metadata || {}), fsm: newCtx };

    logger.info(`🔄 FSM transition [${learner.id}] → ${newState} (v${newCtx.version})`);
  }

  // Lazy getter for courseDelivery (avoids duplicate declarations)
  private async getDeliveryService() {
    return this.getCourseDelivery();
  }
}

export const conversationFSM = new ConversationFSM();
