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

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { sm2Review, labelToQuality } from '../lib/fsrs.js';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Hard cap on background course generation. Sized for one slow reasoning-model
// attempt plus a retry and the DB save; a late result is discarded anyway (see
// generationId), so this only bounds how long the learner waits for an answer.
const GENERATION_TIMEOUT_MS = 180_000;

// ── Input normalisation ────────────────────────────────────────────────────

// Edge characters with no meaning in free text: whitespace, emoji (incl. modifiers,
// variation selector, keycap, and the ZWJ that glues emoji sequences).
const EDGE_NOISE = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u20E3\u200D]+|[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u20E3\u200D]+$/gu;

/**
 * Cleans learner free text (topics, goals, questions) without destroying it:
 * drops control and invisible format characters (zero-width space, BOM, bidi
 * overrides, …) and edge emoji, collapses whitespace. Keeps every script's
 * letters and symbols like "C++" / "C#" / "?". ZWNJ/ZWJ are kept inside the
 * text because Indic scripts use them to shape conjuncts.
 */
export function cleanFreeText(s: string): string {
  return s
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_NOISE, '')
    .trim();
}

/**
 * Normalises input for matching commands, button ids and map keys: lowercases
 * and strips leading/trailing punctuation/emoji so "new topic?" → "new topic".
 * Unicode-aware — letters (\p{L}), combining marks (\p{M}, e.g. Devanagari
 * matras) and digits survive, so "हिंदी" stays "हिंदी".
 */
export function normalizeCommand(s: string): string {
  return cleanFreeText(s)
    .toLowerCase()
    .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '')
    .trim();
}

/** Per-enrollment slot stored at learner.metadata.fsm_dynamic (dynamic + authored engines). */
export interface DynamicSlot {
  state?: string | null;
  version?: number;
  /** Absent on slots written before per-enrollment keying — those are trusted as-is. */
  enrollmentId?: string;
  fsmDefinitionId?: string | null;
}

/**
 * Returns the saved node id only if the slot belongs to this enrollment and FSM
 * definition. A slot from another enrollment (new course) or definition
 * (re-import) means the learner starts this course from the top.
 */
export function resolveDynamicState(slot: DynamicSlot | undefined | null, enrollment: any): string | undefined {
  if (!slot?.state) return undefined;
  if (slot.enrollmentId && slot.enrollmentId !== enrollment?.id) return undefined;
  if (slot.fsmDefinitionId && slot.fsmDefinitionId !== enrollment?.fsm_definition_id) return undefined;
  return slot.state;
}

const RESTART_COMMANDS = new Set(['restart', 'reset', 'start over']);
/** Pause between the feedback on a review answer and the next review question. */
const REVIEW_NEXT_QUESTION_DELAY_MS = process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ? 0 : 1500;

const NEW_TOPIC_COMMANDS = new Set(['new topic', 'new course']);

const getDb = () => import('@ekatra/database').then((m) => m.db);
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
  // Identifies the in-flight course generation; a result for any other id is stale
  generationId?: string;
  // Day-end review: how many bare A/B/C answers were taken for this review lesson,
  // so each reply is graded against the question it answers (buttons carry no id)
  reviewAnswers?: { lessonId: string; count: number };
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

/**
 * What a learner's chat request asks the course generator for. The learner id is stamped on the
 * course (requestedByLearnerId) so deleting their account can tell their own courses from admin ones.
 */
export function courseRequestFor(learner: any, data: FSMData, defaultOrganizationId?: string) {
  return {
    topic: data.topic!,
    goal: data.goal,
    language: data.language || learner.language || 'en',
    style: data.style || 'casual',
    organizationId: defaultOrganizationId || learner.organization_id,
    requestedByLearnerId: learner.id as string,
  };
}

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
    const rawInput = (
      message.text ||
      message.buttonPayload ||
      message.listReplyId ||
      message.buttonReplyId ||
      ''
    ).trim();
    // Normalise: strip leading/trailing punctuation so "new topic?" → "new topic"
    const lower = normalizeCommand(rawInput);

    // ── Dynamic FSM engine: activates when enrollment has fsm_definition_id ─
    let activeEnrollment: any = null;
    try {
      const db = await getDb();
      const enrollment = await db.enrollments.findActiveByLearner(learner.id);
      if (enrollment?.fsm_definition_id) {
        // Global commands first — otherwise help/restart/new topic never reach
        // a learner in a dynamic or authored course.
        if (await this.handleDynamicGlobalCommand(learner, enrollment, lower)) return;
        await this.processDynamic(learner, enrollment, message);
        return;
      }
      activeEnrollment = enrollment;
    } catch (dynErr) {
      logger.error('Dynamic FSM lookup failed, falling back to hardcoded engine:', dynErr);
    }
    // ── Hardcoded engine (fallback for existing learners) ─────────────────
    const ctx = this.getContext(learner);
    let input = rawInput;
    // Free text (topics, goals, questions) keeps its script, case and symbols.
    const freeText = cleanFreeText(rawInput);

    logger.info(`🔄 FSM [${learner.id}] state=${ctx.state} input="${input.substring(0, 50)}"`);

    // ── Global commands — handled in ANY state ─────────────────────────────
    if (RESTART_COMMANDS.has(lower) && activeEnrollment) {
      // Restart the current course from Day 1 (not the whole onboarding).
      if (await this.restartEnrollment(learner, ctx, activeEnrollment)) return;
    }
    if (NEW_TOPIC_COMMANDS.has(lower) && activeEnrollment) {
      // Leave the current course and go straight to picking a new topic —
      // routing through idle would just resume the active enrollment.
      await this.startNewTopic(learner, ctx, activeEnrollment);
      return;
    }
    if (RESTART_COMMANDS.has(lower) || NEW_TOPIC_COMMANDS.has(lower)) {
      await this.transitionTo(learner, ctx, 'idle', {});
      const messaging = await getMessaging();
      await messaging.sendText(learner.phone, {
        text: '🔄 No problem — let\'s start fresh!',
      });
      await this.handleIdle(learner, ctx, message);
      return;
    }
    // Course-complete message offers a "New Course" button whose id is 'menu'.
    if (lower === 'menu' && !activeEnrollment && (ctx.state === 'complete' || ctx.state === 'learning')) {
      await this.handleComplete(learner, ctx, 'new_course');
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
          await this.handleTopicInput(learner, ctx, freeText);
          break;
        case 'goal_input':
          await this.handleGoalInput(learner, ctx, input, freeText);
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
          await this.handleDoubt(learner, ctx, message, input, freeText);
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

    await this.transitionTo(learner, ctx, 'topic_input', ctx.data);

    const isHindi = lang === 'hi';
    await messaging.sendText(learner.phone, {
      text: isHindi
        ? `बढ़िया! 🤩\n\nमैं *Alfred* हूँ — आपका AI टीचर, जो किसी भी विषय पर कोर्स बना सकता है।\n\nआप क्या सीखना चाहते हैं? (उदाहरण: "Python basics" या "शेयर मार्केट की बेसिक्स")`
        : `That's amazing! 🤩\n\nI'm *Alfred*, your AI tutor — I can create a course on any topic you choose.\n\nWhat would you like to learn?\n\n_Example: "Python basics" or "Marketing fundamentals"_`,
    });
  }

  /** Asks how the learner wants this course taught. Asked for every new course, after the topic. */
  private async sendStylePrompt(learner: any, ctx: FSMContext): Promise<void> {
    const messaging = await getMessaging();
    const isHindi = ctx.data.language === 'hi';
    await messaging.sendInteractiveButtons(learner.phone, {
      body: isHindi
        ? `अच्छा चुनाव! 📚 *${ctx.data.topic}*\n\nआप इसे किस तरह से सीखना पसंद करेंगे?`
        : `Great choice! 📚 *${ctx.data.topic}*\n\nHow would you like this course taught?`,
      buttons: [
        { id: 'style_professional', title: isHindi ? 'औपचारिक' : 'Professional' },
        { id: 'style_casual', title: isHindi ? 'आसान भाषा' : 'Casual' },
        { id: 'style_practical', title: isHindi ? 'व्यावहारिक' : 'Practical' },
      ],
    });
  }

  private async sendGoalPrompt(learner: any, ctx: FSMContext): Promise<void> {
    const messaging = await getMessaging();
    await messaging.sendInteractiveButtons(learner.phone, {
      body: `Got it! What's your main goal with *${ctx.data.topic}*?`,
      buttons: [
        { id: 'goal_beginner', title: 'Complete beginner' },
        { id: 'goal_refresh', title: 'Quick refresher' },
        { id: 'goal_practical', title: 'Practical skills' },
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
    if (ctx.data.topic) {
      await this.transitionTo(learner, ctx, 'goal_input', ctx.data);
      await this.sendGoalPrompt(learner, ctx);
      return;
    }
    // A chat that was already past the language step when this changed still gets asked for a topic.
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

    // `input` is cleaned free text (not the command-normalised form), so Hindi
    // topics and "C++"/"C#" survive; reject only input with no letters/digits.
    // A tap on a button from an older message arrives as its id (e.g. "browse_courses"): not a topic.
    if (!input || input.length < 2 || !normalizeCommand(input) || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(input)) {
      await messaging.sendText(learner.phone, {
        text: "Please type what you'd like to learn. For example: *Python basics*",
      });
      return;
    }

    input = input.slice(0, 200);
    ctx.data.topic = input;
    // Each new course asks its own style; a style from an earlier course is not carried over.
    delete ctx.data.style;
    await this.transitionTo(learner, ctx, 'style_input', ctx.data);
    await this.sendStylePrompt(learner, ctx);
  }

  private async handleGoalInput(
    learner: any,
    ctx: FSMContext,
    input: string,
    freeText: string = input,
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

    ctx.data.goal = goalMap[input] || freeText.slice(0, 300) || input;
    await this.transitionTo(learner, ctx, 'confirming', ctx.data);

    const { topic, goal, style, language } = ctx.data;
    const isHindi = language === 'hi';
    const styleLabelMap: Record<string, string> = {
      professional: 'Professional',
      casual: 'Casual & conversational',
      practical: 'Practical & hands-on',
    };
    const styleLabel = styleLabelMap[style || 'casual'] || style || 'Casual';
    const micro = process.env.COURSE_SIZE === 'micro';

    await messaging.sendInteractiveButtons(learner.phone, {
      body: isHindi
        ? `✅ *आपका लर्निंग प्लान:*\n\n📌 *विषय:* ${topic}\n🎯 *लक्ष्य:* ${goal}\n✍️ *शैली:* ${styleLabel}\n📚 *${micro ? '3 छोटे पाठ' : '5 छोटे पाठ'}*, हर एक ~${micro ? '1' : '3'} मिनट\n\nक्या Alfred इसे आपके लिए बनाए?`
        : `✅ *Here's your learning plan:*\n\n📌 *Topic:* ${topic}\n🎯 *Goal:* ${goal}\n✍️ *Style:* ${styleLabel}\n📚 *${micro ? '3 bite-sized lessons' : '5 bite-sized lessons'}*, each ~${micro ? '1' : '3'} min\n✨ *Includes:* Explanations, quizzes & flashcards\n\nShall Alfred generate this course for you?`,
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

    // Confirmed → kick off async course generation. The generationId lets the
    // background job tell whether its result is still wanted when it finishes.
    const generationId = randomUUID();
    await this.transitionTo(learner, ctx, 'generating', { ...ctx.data, generationId });
    const firstName = (learner.name || '').split(' ')[0];
    const nameStr = firstName ? `, ${firstName}` : '';
    await messaging.sendText(learner.phone, {
      text: `🔄 I'm creating your course with pictures — usually a minute or two. I'll message you here as soon as it's ready. ✨`,
    });

    // Generate in background (don't await in the webhook response).
    // A hard timeout ensures the learner is never stuck in `generating`
    // indefinitely if the LLM hangs without throwing. The race does not cancel
    // the generation — generateCourseAsync checks generationId before applying.
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Course generation timed out after ${ms / 1000}s`)), ms);
      });
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    };

    withTimeout(this.generateCourseAsync(learner, ctx.data), GENERATION_TIMEOUT_MS).catch(async (err) => {
      logger.error('Async course generation failed (outer catch):', err);
      try {
        const db = await getDb();
        const messaging = await getMessaging();
        const freshLearner = await db.learners.findById(learner.id);
        if (!freshLearner) return;
        const freshCtx = this.getContext(freshLearner);
        // Only reset + notify if this generation is still the one the learner is
        // waiting on — they may have restarted or already been told it failed.
        if (!this.isCurrentGeneration(freshCtx, generationId)) {
          logger.info(`Generation ${generationId} timed out after learner ${learner.id} moved on — no reset`);
          return;
        }
        await this.transitionTo(freshLearner, freshCtx, 'topic_input', {});
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
      await this.restartEnrollment(learner, ctx, enrollment);
    } else if (input === 'next' || input === 'continue' || input === 'start_day' || input === 'start now' || input === 'next lesson' || input === 'next →' || input === 'next module' || input === '1') {
      await this.resumeOrAdvance(learner, ctx, enrollment);
    } else if (input.startsWith('quiz_')) {
      await this.handleQuizResponse(learner, enrollment, input, ctx);
    } else if (/^[a-d]$/.test(input)) {
      // Content API quick-reply tap: user picked quiz option A/B/C/D
      const questions = enrollment.current_lesson_id
        ? await db.quiz.findByLesson(enrollment.current_lesson_id)
        : [];
      if (questions.length > 0) {
        const question = await this.pickAnsweredQuestion(learner, ctx, enrollment, questions);
        await this.handleQuizResponse(learner, enrollment, `quiz_${question.id}_${input.toUpperCase()}`, ctx);
      } else {
        // No quiz on this lesson — treat like "next", but never skip an undelivered lesson
        await this.resumeOrAdvance(learner, ctx, enrollment);
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
    freeText: string = input,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    if (input === 'next' || input === 'continue' || input === 'next_lesson' || input === 'next lesson') {
      // Exit doubt state → resume learning: deliver the current lesson if it was
      // never sent, otherwise advance (don't re-send a module already read).
      await this.transitionTo(learner, ctx, 'learning', ctx.data);
      const enrollment = await db.enrollments.findById(ctx.data.enrollmentId!);
      if (enrollment) {
        await this.resumeOrAdvance(learner, ctx, enrollment);
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

    // doubt_yes from the loop prompt — just prompt them to type their question
    if (
      input === 'doubt_yes' ||
      input === 'yes, another question' ||
      input === 'ask_question' ||
      input === 'ask another' ||
      input === 'ask'
    ) {
      await messaging.sendText(learner.phone, {
        text: "❓ Go ahead — type your question!",
      });
      return;
    }

    if (!freeText || freeText.length < 3 || !input) {
      await messaging.sendText(learner.phone, {
        text: "Please type your question and I'll help you!",
      });
      return;
    }

    const qaService = await this.getQAService();
    const enrollment = await db.enrollments.findById(ctx.data.enrollmentId!);
    // The loop prompt below is the only follow-up — QAService's own buttons would compete with it.
    await qaService.handleTextQuestion(learner, enrollment, freeText, { followUpButtons: false });

    // After answering, loop — ask if there are more doubts
    await messaging.sendInteractiveButtons(learner.phone, {
      body: 'Any other doubts? 🤔',
      buttons: [
        { id: 'doubt_yes', title: 'Yes, another question' },
        { id: 'next', title: 'Continue Course' },
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
    const generationId = data.generationId;

    try {
      const generator = await this.getGeneratorService();
      const org = await db.organizations.getDefault();

      const course = await generator.generate(courseRequestFor(learner, data, org?.id));

      // Enroll the learner
      const lessons = await db.lessons.findByCourse(course.id);
      const firstLesson = lessons[0];

      // The hardcoded engine delivers from lesson rows — a course without any
      // would leave the learner looping on "Something went wrong loading your lesson".
      if (lessons.length === 0) {
        throw new Error(`Course ${course.id} has no lessons — not enrolling`);
      }

      // The learner may have moved on while we were generating (timeout already
      // reported, restart, new topic) — never overwrite their newer state.
      const learnerBeforeEnroll = await db.learners.findById(learner.id);
      if (!this.isCurrentGeneration(this.getContext(learnerBeforeEnroll), generationId)) {
        logger.warn(`Discarding late course generation ${generationId} (course ${course.id}) — learner ${learner.id} moved on`);
        return;
      }

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
      if (!this.isCurrentGeneration(freshCtx, generationId)) {
        // Lost the race while enrolling — don't leave an orphan active enrollment behind.
        await db.enrollments.update(enrollment.id, { status: 'dropped' });
        logger.warn(`Discarding late course generation ${generationId} — learner ${learner.id} moved on during enrollment`);
        return;
      }
      await this.transitionTo(freshLearner, freshCtx, 'learning', {
        courseId: course.id,
        enrollmentId: enrollment.id,
        topic: data.topic,
        goal: data.goal,
        language: data.language,
        style: data.style,
      });

      // Notify learner — with the cover picture when one was generated (best-effort)
      const readyText = `✅ Your course *${course.title}* is ready!\n\nIt has ${lessons.length} lessons. Let's start your first one! 🚀`;
      const { absoluteMediaUrl } = await import('@ekatra/messaging');
      const coverUrl = absoluteMediaUrl((await db.courses.findById(course.id).catch(() => null))?.settings?.coverImageUrl);
      const coverSent = coverUrl
        ? await messaging.sendImage(learner.phone, { imageUrl: coverUrl, caption: readyText }).catch(() => null)
        : null;
      if (!coverSent?.success) {
        await messaging.sendText(learner.phone, { text: readyText });
      }

      // Send the first lesson immediately — use the enrollment we just created
      const courseDelivery = await this.getDeliveryService();
      const freshEnrollment = await db.enrollments.findById(enrollment.id);
      await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
    } catch (err: any) {
      logger.error('Background course generation failed:', err);

      // Reset state so the user can try again — unless they already moved on
      // (e.g. the outer timeout already reset and notified them).
      const freshLearner = await db.learners.findById(learner.id);
      const freshCtx = this.getContext(freshLearner);
      if (!this.isCurrentGeneration(freshCtx, generationId)) {
        logger.info(`Generation ${generationId} failed after learner ${learner.id} moved on — no reset`);
        return;
      }
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

  // ── M13a learning signals ─────────────────────────────────────────────────
  // Fully detached fire-and-forget: even a failing dynamic import must never
  // reach the delivery path (an awaited import rejection would fall through to
  // the hardcoded-engine catch and re-process the message).
  private emitLearnerEvent(data: {
    learnerId: string;
    courseId?: string | null;
    nodeId?: string | null;
    type: string;
    payload?: any;
    timezone?: string | null;
  }): void {
    import('../services/learnerProfile.js')
      .then((m) => m.recordLearnerEvent(data))
      .catch((err) => logger.warn(`learner event emit skipped: ${(err as Error)?.message}`));
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

    // M13a signal — fire-and-forget, never blocks the reply (AC1b).
    // Only a validated option token is stored, never raw learner text.
    this.emitLearnerEvent({
      learnerId: learner.id,
      courseId: enrollment.course_id ?? null,
      nodeId: questionId,
      type: 'quiz_answered',
      payload: {
        correct: isCorrect,
        option_id: /^[A-Z0-9_-]{1,10}$/i.test(answer) ? answer : undefined,
        lesson_id: enrollment.current_lesson_id,
      },
      timezone: learner.timezone,
    });

    const feedback = isCorrect
      ? `✅ *Correct!*\n\n${question.explanation || 'Well done!'}`
      : `❌ *Not quite.* The answer was *${question.correct_answer}*.\n\n${question.explanation || ''}`;

    await messaging.sendText(learner.phone, { text: feedback });

    // Day-end review: questions arrive one at a time. After this answer, send the next one
    // (if any); only after the last does the learner get the continue prompt below.
    const answeredLesson = await db.lessons.findById(enrollment.current_lesson_id);
    if (answeredLesson?.content_type === 'review') {
      const shown = questions.slice(0, 3);
      const at = shown.findIndex((q: any) => q.id === questionId);
      if (at >= 0 && at + 1 < shown.length) {
        await new Promise((resolve) => setTimeout(resolve, REVIEW_NEXT_QUESTION_DELAY_MS));
        await courseDelivery.sendQuiz(learner.phone, shown[at + 1]);
        return;
      }
    }

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

    const fsmJson = fsmDef.fsm_json as { states: any[]; transitions: any[]; startNodeId?: string };

    // Imported authored courses (M12) carry startNodeId and content-bearing nodes —
    // they run on their own chain-delivery engine, not the one-step editor engine below.
    if (fsmJson.startNodeId) {
      await this.processAuthored(learner, enrollment, fsmJson, normalizedInput);
      return;
    }

    const states: any[] = fsmJson.states ?? [];
    const transitions: any[] = fsmJson.transitions ?? [];

    // Resolve current state — default to the start node. State saved for another
    // enrollment/definition, or an end node on a (re-)activated enrollment, restarts.
    const startNode = states.find((s) => s.type === 'start') ?? states[0];
    let savedStateId = resolveDynamicState(learner.metadata?.fsm_dynamic, enrollment);
    if (savedStateId && states.find((s) => s.id === savedStateId)?.type === 'end') savedStateId = undefined;
    const currentStateId: string = savedStateId ?? startNode?.id;

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
      // Re-prompt with what this step actually accepts instead of a dead-end error.
      const triggers = [...new Set(
        transitions
          .filter((t) => t.from === currentStateId && t.trigger)
          .map((t) => String(t.trigger)),
      )];
      await messaging.sendText(learner.phone, {
        text: triggers.length > 0
          ? `Please reply with ${triggers.length === 1 ? '' : 'one of: '}${triggers.map((t) => `*${t}*`).join(', ')}\n\nType *help* for more options.`
          : 'Type *help* for options.',
      });
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
    const newDynamicCtx = await this.writeDynamicSlot(learner, enrollment, transition.to);

    if (!newDynamicCtx) {
      logger.warn(`⚠️  Dynamic FSM optimistic lock conflict for learner ${learner.id} — state update skipped`);
    } else {
      logger.info(`⚡ Dynamic FSM [${learner.id}] → ${transition.to} (v${newDynamicCtx.version})`);
    }
  }

  /**
   * Writes learner.metadata.fsm_dynamic for this enrollment under the optimistic
   * version lock. `stateId: null` clears progress (next message starts over).
   * Returns the written slot, or null on a lock conflict.
   */
  private async writeDynamicSlot(learner: any, enrollment: any, stateId: string | null): Promise<DynamicSlot | null> {
    const currentVersion: number = learner.metadata?.fsm_dynamic?.version ?? 0;
    const newCtx: DynamicSlot = {
      state: stateId,
      version: currentVersion + 1,
      enrollmentId: enrollment.id,
      fsmDefinitionId: enrollment.fsm_definition_id ?? null,
    };
    const db = await getDb();
    const updated = await db.raw(
      `UPDATE learners
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{fsm_dynamic}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2
         AND (metadata->'fsm_dynamic'->>'version' IS NULL OR (metadata->'fsm_dynamic'->>'version')::int = $3)
       RETURNING id`,
      [JSON.stringify(newCtx), learner.id, currentVersion]
    );
    if (!updated?.rows?.length) return null;
    // Keep the in-memory copy fresh so multi-hop chains in one request don't reuse a stale version.
    learner.metadata = { ...(learner.metadata ?? {}), fsm_dynamic: newCtx };
    return newCtx;
  }

  // ── Authored-course engine (M12) ──────────────────────────────────────────
  // Imported courses deliver chains of content nodes per learner input: render the
  // target node, then keep following __auto__ edges (with a natural pause) until a
  // wait point — a node with buttons, a quiz, or a day_end. State persists at the
  // wait point via the same optimistic-locked fsm_dynamic slot the M10 engine uses.

  private async processAuthored(
    learner: any,
    enrollment: any,
    fsmJson: { states: any[]; transitions: any[]; startNodeId?: string },
    normalizedInput: string,
  ): Promise<void> {
    const messaging = await getMessaging();
    const renderer = await import('../services/authoredContentRenderer.js');

    const stateMap = new Map<string, any>((fsmJson.states ?? []).map((s: any) => [s.id, s]));
    const outgoing = (id: string) => (fsmJson.transitions ?? []).filter((t: any) => t.from === id);

    // Only state saved for THIS enrollment + definition counts — node ids repeat
    // across compiled courses (e.g. every course ends at 'end_1').
    const currentId: string | undefined = resolveDynamicState(learner.metadata?.fsm_dynamic, enrollment);

    // First contact, stale state from a re-import/another course, or a finished
    // course whose enrollment was re-activated: deliver from the start.
    if (!currentId || !stateMap.has(currentId) || stateMap.get(currentId)?.type === 'end') {
      await this.deliverAuthoredChain(learner, enrollment, fsmJson.startNodeId!, stateMap, outgoing);
      return;
    }

    const node = stateMap.get(currentId);
    const edges = outgoing(currentId);

    if (node.type === 'quiz') {
      const picked = renderer.matchQuizOption(node, normalizedInput);
      if (!picked) {
        await renderer.repromptAuthoredNode(learner.phone, node, edges);
        return;
      }
      const correct = (node.options ?? []).find((o: any) => o.correct);
      const feedback = picked.correct
        ? '✅ Correct!'
        : correct
          ? `❌ Not quite — the answer is *${correct.label}*`
          : '👍 Noted!';
      await messaging.sendText(learner.phone, { text: feedback });
      logger.info(`📝 Authored quiz [${learner.id}] ${node.id}: picked "${picked.label}" correct=${!!picked.correct}`);

      // M13a signal — persisted at answer time (correctness previously lived only in this log line)
      this.emitLearnerEvent({
        learnerId: learner.id,
        courseId: enrollment.course_id ?? null,
        nodeId: node.id,
        type: 'quiz_answered',
        payload: { correct: !!picked.correct, option_id: String(picked.id ?? picked.label ?? '').slice(0, 64) },
        timezone: learner.timezone,
      });
      if (edges[0]) await this.deliverAuthoredChain(learner, enrollment, edges[0].to, stateMap, outgoing);
      return;
    }

    // day_end waits for any input; other nodes need a matching button trigger.
    const matched =
      node.type === 'day_end'
        ? edges[0]
        : edges.find((t: any) => t.trigger !== renderer.AUTO_TRIGGER && t.trigger === normalizedInput)
          ?? (edges.length === 1 && edges[0].trigger === renderer.AUTO_TRIGGER ? edges[0] : undefined);

    if (!matched) {
      await renderer.repromptAuthoredNode(learner.phone, node, edges);
      return;
    }
    await this.deliverAuthoredChain(learner, enrollment, matched.to, stateMap, outgoing);
  }

  private async deliverAuthoredChain(
    learner: any,
    enrollment: any,
    startId: string,
    stateMap: Map<string, any>,
    outgoing: (id: string) => any[],
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();
    const renderer = await import('../services/authoredContentRenderer.js');
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let cursor: string | undefined = startId;
    let rendered = 0;
    const MAX_CHAIN = 25; // safety valve — longest auto-run in the Design Thinking course is well under this

    while (cursor && rendered < MAX_CHAIN) {
      const node = stateMap.get(cursor);
      if (!node) {
        logger.error(`Authored chain: node "${cursor}" missing`);
        break;
      }

      if (node.type === 'end') {
        await db.enrollments.update(enrollment.id, { status: 'completed' });
        await messaging.sendText(learner.phone, { text: '🎉 You have completed this course! Well done.' });
        await this.persistAuthoredState(learner, enrollment, cursor);
        this.emitLearnerEvent({
          learnerId: learner.id,
          courseId: enrollment.course_id ?? null,
          nodeId: node.id,
          type: 'course_completed',
          timezone: learner.timezone,
        });
        return;
      }

      const edges = outgoing(cursor);
      await renderer.renderAuthoredNode(learner.phone, node, edges);
      rendered++;

      // M13a signal — reaching a day_end means the learner finished a day's lesson
      if (node.type === 'day_end') {
        this.emitLearnerEvent({
          learnerId: learner.id,
          courseId: enrollment.course_id ?? null,
          nodeId: node.id,
          type: 'lesson_completed',
          timezone: learner.timezone,
        });
      }

      const autoEdge = edges.length === 1 && edges[0].trigger === renderer.AUTO_TRIGGER ? edges[0] : undefined;
      const isWaitPoint = node.type === 'quiz' || node.type === 'day_end' || !autoEdge;
      if (isWaitPoint) break;

      cursor = autoEdge.to;
      await delay(900); // natural reading pace between auto-advanced messages
    }

    if (rendered >= MAX_CHAIN) {
      logger.warn(`Authored chain for learner ${learner.id} hit the ${MAX_CHAIN}-node safety cap at "${cursor}"`);
    }
    if (cursor) await this.persistAuthoredState(learner, enrollment, cursor);
  }

  private async persistAuthoredState(learner: any, enrollment: any, stateId: string): Promise<void> {
    const newCtx = await this.writeDynamicSlot(learner, enrollment, stateId);
    if (!newCtx) {
      logger.warn(`⚠️  Authored FSM optimistic lock conflict for learner ${learner.id} — state update skipped`);
    } else {
      logger.info(`⚡ Authored FSM [${learner.id}] → ${stateId} (v${newCtx.version})`);
    }
  }

  // ── Global commands / resume helpers ──────────────────────────────────────

  /**
   * help / menu / restart / new topic for learners in a dynamic or authored
   * course. Returns true when the input was a global command and was handled.
   */
  private async handleDynamicGlobalCommand(learner: any, enrollment: any, lower: string): Promise<boolean> {
    const messaging = await getMessaging();

    if (lower === 'help' || lower === 'menu') {
      await messaging.sendText(learner.phone, {
        text:
          `📋 *Here\'s what you can do:*\n\n` +
          `• Tap the buttons (or type their text) to move through the course\n` +
          `• *restart* — start your current course over\n` +
          `• *new topic* — pick a different topic\n` +
          `• *help* — show this menu`,
      });
      return true;
    }

    if (RESTART_COMMANDS.has(lower)) {
      if (!(await this.writeDynamicSlot(learner, enrollment, null))) {
        logger.warn(`⚠️  Dynamic FSM restart lock conflict for learner ${learner.id}`);
      }
      await messaging.sendText(learner.phone, { text: '🔄 Restarting your course from the beginning!' });
      // Empty input: the authored engine delivers from the start node, the
      // editor engine re-prompts with the start node's triggers.
      await this.processDynamic(learner, enrollment, { from: learner.phone, type: 'text', text: '' });
      return true;
    }

    if (NEW_TOPIC_COMMANDS.has(lower)) {
      await this.startNewTopic(learner, this.getContext(learner), enrollment);
      return true;
    }

    return false;
  }

  /** Leaves the active enrollment and asks for a new topic (skips onboarding). */
  private async startNewTopic(learner: any, ctx: FSMContext, enrollment: any): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();
    // 'dropped' takes it out of findActiveByLearner so idle/dynamic routing won't resume it.
    await db.enrollments.update(enrollment.id, { status: 'dropped' });
    await this.transitionTo(learner, ctx, 'topic_input', {
      language: ctx.data?.language ?? learner.language,
      style: ctx.data?.style,
    });
    await messaging.sendText(learner.phone, {
      text: 'No problem! What topic would you like to learn instead?',
    });
  }

  /**
   * Resets a hardcoded-engine enrollment to Day 1, Module 1 and delivers it.
   * Returns false when the course has no regular lessons to restart from.
   */
  private async restartEnrollment(learner: any, ctx: FSMContext, enrollment: any): Promise<boolean> {
    const db = await getDb();
    const messaging = await getMessaging();
    const courseDelivery = await this.getCourseDelivery();

    const allLessons = await db.lessons.findByCourse(enrollment.course_id);
    const firstLesson = allLessons.find((l: any) => l.content_type !== 'review');
    if (!firstLesson) return false;

    await db.enrollments.update(enrollment.id, {
      currentLessonId: firstLesson.id,
      progress: 0,
      status: 'in_progress',
    });
    await this.transitionTo(learner, ctx, 'learning', {
      courseId: enrollment.course_id,
      enrollmentId: enrollment.id,
      language: ctx.data?.language,
      style: ctx.data?.style,
    });
    await messaging.sendText(learner.phone, {
      text: "🔄 Restarting from Day 1, Module 1. Let's go! 🚀",
    });
    await delay(2000);
    const freshEnrollment = await db.enrollments.findById(enrollment.id);
    if (freshEnrollment) {
      await courseDelivery.sendNextLesson(learner.phone, freshEnrollment);
    }
    return true;
  }

  /**
   * "Next"/"Continue": deliver the current lesson if it was never sent (e.g. the
   * pointer was moved to the next day's first module by the day-end flow),
   * otherwise complete it and advance. Review lessons keep the day-end path.
   */
  private async resumeOrAdvance(learner: any, ctx: FSMContext, enrollment: any): Promise<void> {
    const db = await getDb();
    const courseDelivery = await this.getCourseDelivery();

    if (!enrollment.current_lesson_id) {
      await courseDelivery.sendNextLesson(learner.phone, enrollment);
      return;
    }

    // If current lesson is a review (day-end comprehension), route to markDayReviewComplete
    // so the doubt loop fires. Otherwise use the normal markLessonComplete path.
    const currentLesson = await db.lessons.findById(enrollment.current_lesson_id);
    if (currentLesson?.content_type === 'review') {
      await courseDelivery.markDayReviewComplete(enrollment.id, enrollment.current_lesson_id);
    } else {
      const progress = await db.lessonProgress.find(enrollment.id, enrollment.current_lesson_id);
      if (!progress) {
        // Never delivered — send it instead of marking it complete unseen.
        await courseDelivery.sendNextLesson(learner.phone, enrollment);
        return;
      }
      await courseDelivery.markLessonComplete(enrollment.id, enrollment.current_lesson_id);
    }

    // If enrollment is now complete, transition FSM to complete state
    const refreshed = await db.enrollments.findById(enrollment.id);
    if (refreshed?.status === 'completed') {
      await this.transitionTo(learner, ctx, 'complete', {});
    }
  }

  /**
   * Which question a bare "A"/"B"/"C" reply answers. Regular lessons only ever
   * show their first question. The day-end review sends up to 3 questions whose
   * buttons are all just A/B/C, so replies are taken in order and counted per
   * review lesson in ctx.data.reviewAnswers.
   */
  private async pickAnsweredQuestion(learner: any, ctx: FSMContext, enrollment: any, questions: any[]): Promise<any> {
    if (questions.length === 1) return questions[0];
    const db = await getDb();
    const lesson = await db.lessons.findById(enrollment.current_lesson_id);
    if (lesson?.content_type !== 'review') return questions[0];

    const shown = Math.min(questions.length, 3);
    const prev = ctx.data.reviewAnswers;
    const answered = prev && prev.lessonId === enrollment.current_lesson_id ? prev.count : 0;
    const question = questions[Math.min(answered, shown - 1)];
    await this.transitionTo(learner, ctx, ctx.state, {
      ...ctx.data,
      reviewAnswers: { lessonId: enrollment.current_lesson_id, count: answered + 1 },
    });
    return question;
  }

  /** True while the learner is still waiting on this specific course generation. */
  private isCurrentGeneration(ctx: FSMContext, generationId: string | undefined): boolean {
    if (ctx.state !== 'generating') return false;
    // Generations started before generationId existed only have the state check.
    return !generationId || ctx.data?.generationId === generationId;
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
