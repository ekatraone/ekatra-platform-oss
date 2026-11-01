/**
 * Shared Course Delivery Service
 *
 * Handles sending course lessons to learners via WhatsApp
 * Uses lazy imports to avoid circular dependencies
 */

import { logger } from '../lib/logger.js';
import { markdownToWhatsApp } from '../lib/whatsappFormatter.js';
import { issueCertificate } from './certificateService.js';
import { modelRouter } from '../lib/modelRouter.js';
import { checkedSend } from '../sendResult.js';

// Varied lesson intro greetings — rotates so 5 lessons don't all feel the same
const LESSON_GREETINGS = [
  "Let's dive in! 🚀",
  "Here we go! 💪",
  "Ready? Let's learn! 📖",
  "Time to level up! ⚡",
  "Let's get into it! 🎯",
  "Knowledge time! 🧠",
  "Here's your next lesson! 📝",
  "Let's keep the momentum! 🔥",
  "Onward! 🌟",
];

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Strips markdown so the prompt reads as plain description text, not literal syntax
const plain = (s: string) => (s || '').replace(/[*_`#>[\]()]/g, '').slice(0, 320);

// Content-aware prompt for the lesson illustration — title alone produces
// generic, interchangeable art; a snippet of the actual content grounds it.
function buildIllustrationPrompt(lesson: { title: string; content?: string }): string {
  return [
    `Educational flat-illustration for a micro-learning app, for the lesson "${lesson.title}".`,
    `Lesson content: "${plain(lesson.content || '')}"`,
    'Depict the core concept concretely (a scene, object, or simple diagram), not an abstract mood board.',
    'Style: clean flat vector illustration, warm approachable colors, simple shapes, no text or letters in the image, no logos, no watermark.',
  ].join(' ');
}

// One illustration per lesson, shared by every learner who receives it. The
// in-flight promise is cached (single-flight), so a cohort push on the same
// lesson triggers one generation instead of one per recipient. Bounded so the
// ~1-2MB buffers can't accumulate; failures are evicted so a later send retries.
const ILLUSTRATION_CACHE_MAX = 20;
const illustrationCache = new Map<string, Promise<Buffer>>();

function lessonIllustration(lesson: { id: string; title: string; content?: string; updated_at?: unknown }): Promise<Buffer> {
  const key = `${lesson.id}:${lesson.updated_at ? new Date(lesson.updated_at as any).getTime() : ''}`;
  const cached = illustrationCache.get(key);
  if (cached) return cached;
  const pending = modelRouter.generateImage(buildIllustrationPrompt(lesson), { quality: 'low' });
  illustrationCache.set(key, pending);
  pending.catch(() => illustrationCache.delete(key));
  while (illustrationCache.size > ILLUSTRATION_CACHE_MAX) {
    illustrationCache.delete(illustrationCache.keys().next().value as string);
  }
  return pending;
}

const QUIZ_BUTTON_LIMIT = 3; // WhatsApp reply-button cap

/**
 * Build the multiple-choice quiz prompt. Every option is listed in the body
 * (A, B, C, D, ...). Telegram shows one button per option; WhatsApp caps reply
 * buttons at 3, so options past C are answered by typing the letter (the FSM
 * accepts a bare a-d reply). Button ids stay bare letters for the FSM route.
 */
export function buildQuizPrompt(
  question: { question: string; options: string[] },
  opts: { telegram: boolean },
): { body: string; buttons: Array<{ id: string; title: string }> } {
  const letters = question.options.map((_, idx) => String.fromCharCode(65 + idx));
  const optionsText = question.options.map((opt, idx) => `${letters[idx]}) ${opt}`).join('\n');
  const buttonLetters = opts.telegram ? letters : letters.slice(0, QUIZ_BUTTON_LIMIT);
  const typed = letters.slice(buttonLetters.length);
  const hint = typed.length > 0
    ? `\n\n_Tap a button, or reply *${typed.join('* / *')}*_`
    : '';
  return {
    body: `${question.question}\n\n${optionsText}${hint}`,
    buttons: buttonLetters.map(letter => ({ id: letter, title: letter })),
  };
}

// Lazy imports
const getDb = () => import('@ekatra/database').then(m => m.db);
const getMessaging = () => import('@ekatra/messaging').then(m => m.messaging);
const getTemplates = () => import('@ekatra/messaging').then(m => m.TWILIO_TEMPLATES);

export class CourseDeliveryService {

  /**
   * Send next lesson to learner
   */
  async sendNextLesson(
    phone: string,
    enrollment: any,
    options: { deferIllustration?: (send: () => Promise<void>) => void } = {},
  ): Promise<boolean> {
    try {
      const db = await getDb();
      const messaging = await getMessaging();

      logger.info(`Sending lesson to ${phone} for enrollment ${enrollment.id}`);

      // Get current lesson or first lesson if none set
      let lesson;
      if (enrollment.current_lesson_id) {
        lesson = await db.lessons.findById(enrollment.current_lesson_id);
      } else {
        const lessons = await db.lessons.findByCourse(enrollment.course_id);
        lesson = lessons[0];
        if (lesson) {
          await db.enrollments.update(enrollment.id, { currentLessonId: lesson.id });
        }
      }

      if (!lesson) {
        logger.warn(`No lesson found for enrollment ${enrollment.id}`);
        const messaging = await getMessaging();
        await checkedSend(messaging.sendText(phone, {
          text: "⚠️ Something went wrong loading your lesson. Please type *next* to try again.",
        }));
        return false;
      }

      // Skip review lessons — they're delivered by the day-end flow, not by direct dispatch
      if (lesson.content_type === 'review') {
        logger.info(`Skipping review lesson ${lesson.id} for ${phone} — handled by day-end flow`);
        return true;
      }

      // Get course and learner for context
      const [course, learner, allLessons] = await Promise.all([
        db.courses.findById(enrollment.course_id),
        db.learners.findById(enrollment.learner_id),
        db.lessons.findByCourse(enrollment.course_id),
      ]);

      // Compute Day X / Module Y within that day (exclude review lessons from count)
      const regularLessons = allLessons.filter((l: any) => l.content_type !== 'review');
      const dayNumber = lesson.day_number ?? 1;
      const lessonsInDay = regularLessons.filter((l: any) => (l.day_number ?? 1) === dayNumber);
      const moduleInDay = lessonsInDay.findIndex((l: any) => l.id === lesson.id) + 1;
      const totalDays = Math.max(...regularLessons.map((l: any) => l.day_number ?? 1), 1);

      const lessonNum = lesson.sequence_order;
      const totalLessons = regularLessons.length;
      const firstName = (learner?.name || '').split(' ')[0] || '';
      const greeting = LESSON_GREETINGS[(lessonNum - 1) % LESSON_GREETINGS.length];

      // Header line: "Day 1, Module 2/3 · Course Name"
      const pct = Math.round((regularLessons.filter((l: any) => l.sequence_order < lessonNum).length / totalLessons) * 100);
      const filled = Math.round(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      const headerLine = `📚 *Day ${dayNumber}/${totalDays} · Module ${moduleInDay}/${lessonsInDay.length}* — _${course?.title || 'Course'}_`;
      const progressLine = `📊 ${bar} ${pct}%`;
      const nameLine = firstName ? `\n${greeting} ${firstName} 👇` : `\n${greeting}`;

      await checkedSend(messaging.sendText(phone, {
        text: `${headerLine}\n${progressLine}${nameLine}`,
      }));

      // Deliberate pause so the header lands before the content
      await delay(1200);

      // AI-generated illustration: picture first, then the text. Best-effort — a failed
      // image never blocks the lesson. Telegram has its own illustration flow below.
      if (lesson.media_url && lesson.content_type === 'text') {
        const { isTelegramRecipient, absoluteMediaUrl } = await import('@ekatra/messaging');
        // media_url is stored as a relative path; anything else is ignored.
        const imageUrl = absoluteMediaUrl(lesson.media_url);
        if (imageUrl && !isTelegramRecipient(phone)) {
          const sentImage = await messaging.sendImage(phone, { imageUrl }).catch((err: any) => ({ success: false, error: err?.message }));
          if (!sentImage?.success) logger.warn(`Lesson image not sent (${lesson.id}): ${sentImage?.error}`);
          else await delay(800);
        }
      }

      // Lesson title + content
      await checkedSend(messaging.sendText(phone, {
        text: `*${lesson.title}*\n\n${markdownToWhatsApp(lesson.content)}`,
      }));

      // Create or update lesson progress
      let progress = await db.lessonProgress.find(enrollment.id, lesson.id);
      if (!progress) {
        await db.lessonProgress.create({
          enrollmentId: enrollment.id,
          lessonId: lesson.id,
          status: 'started',
        });
      }

      // Pause before the action prompt — feels natural
      await delay(1500);

      // Check if there are quiz questions
      const questions = await db.quiz.findByLesson(lesson.id);
      if (questions.length > 0) {
        await this.sendQuiz(phone, questions[0]);
      } else {
        await checkedSend(messaging.sendInteractiveButtons(phone, {
          body: `Module ${lessonNum} delivered ✅\n\nTake your time. Tap *Next Module* when ready!`,
          buttons: [
            { id: 'next', title: 'Next Module' },
            { id: 'ask_question', title: 'Ask a Question' },
          ],
        }));
      }

      // Illustration — sent after the button/quiz so the learner can act
      // immediately instead of waiting ~15-20s of dead air for image generation.
      // Interactive path: deliberately not awaited — the per-learner lock is
      // released as soon as sendNextLesson returns, so a slow image call must
      // not hold it open (rapid taps would otherwise find the lock held).
      // Bulk schedule path: the caller collects it via deferIllustration and
      // awaits it with bounded concurrency after the batch loop.
      // Telegram only today — WhatsApp needs the Meta media-upload API.
      const { isTelegramRecipient } = await import('@ekatra/messaging');
      if (isTelegramRecipient(phone) && modelRouter.capabilities().image) {
        const sendIllustration = async () => {
          try {
            const image = await lessonIllustration(lesson);
            await checkedSend(messaging.sendImageBuffer(phone, image, lesson.title));
          } catch (err: any) {
            logger.warn('Lesson illustration failed, continuing without it:', err);
          }
        };
        if (options.deferIllustration) options.deferIllustration(sendIllustration);
        else void sendIllustration();
      }

      return true;
    } catch (error) {
      logger.error('Error sending lesson:', error);
      return false;
    }
  }

  /**
   * Send lesson content based on type — used for media/audio lessons.
   * Plain text content is sent inline in sendNextLesson for better pacing.
   */
  private async sendLessonContent(phone: string, lesson: any): Promise<void> {
    const messaging = await getMessaging();

    switch (lesson.content_type) {
      case 'image':
        if (lesson.media_url) {
          await checkedSend(messaging.sendImage(phone, { imageUrl: lesson.media_url, caption: lesson.content || '' }));
        } else {
          await checkedSend(messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) }));
        }
        break;
      case 'video':
        if (lesson.media_url) {
          await checkedSend(messaging.sendVideo(phone, { videoUrl: lesson.media_url, caption: lesson.content || '' }));
        } else {
          await checkedSend(messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) }));
        }
        break;
      case 'document':
        if (lesson.media_url) {
          await checkedSend(messaging.sendDocument(phone, { documentUrl: lesson.media_url, filename: lesson.title, caption: lesson.content || '' }));
        } else {
          await checkedSend(messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) }));
        }
        break;
      case 'audio':
        if (lesson.media_url) {
          await checkedSend(messaging.sendAudio(phone, lesson.media_url));
        }
        break;
      default:
        // text: handled inline in sendNextLesson (already sent)
        break;
    }
  }

  /**
   * Send quiz question
   */
  async sendQuiz(phone: string, question: any): Promise<void> {
    const messaging = await getMessaging();

    if (question.question_type === 'multiple_choice' && question.options) {
      // Put all options in body text, use letters as button labels.
      // When user taps a button, Twilio sends Body="A" (the title),
      // which the FSM maps to quiz_<questionId>_A using the active lesson.
      const { isTelegramRecipient } = await import('@ekatra/messaging');
      await checkedSend(messaging.sendInteractiveButtons(phone, buildQuizPrompt(
        { question: question.question, options: question.options as string[] },
        { telegram: isTelegramRecipient(phone) },
      )));
    } else {
      await checkedSend(messaging.sendText(phone, {
        text: `❓ ${question.question}\n\n_Reply with your answer_`
      }));
    }
  }

  /**
   * Mark lesson as complete and advance
   */
  async markLessonComplete(enrollmentId: string, lessonId: string): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    // Update lesson progress
    const progress = await db.lessonProgress.find(enrollmentId, lessonId);
    if (progress) {
      await db.lessonProgress.update(progress.id, {
        status: 'completed',
        completedAt: new Date()
      });
    }

    // Get enrollment and find next lesson
    const enrollment = await db.enrollments.findById(enrollmentId);
    if (!enrollment) return;

    const [lessons, learner] = await Promise.all([
      db.lessons.findByCourse(enrollment.course_id),
      db.learners.findById(enrollment.learner_id),
    ]);

    const currentIdx = lessons.findIndex((l: any) => l.id === lessonId);
    const currentLesson = lessons[currentIdx];
    const nextLesson = lessons[currentIdx + 1];
    const firstName = (learner?.name || '').split(' ')[0] || '';
    const completedNum = currentIdx + 1;
    const totalLessons = lessons.length;

    if (nextLesson) {
      const pct = Math.round((completedNum / totalLessons) * 100);
      await db.enrollments.update(enrollmentId, {
        currentLessonId: nextLesson.id,
        progress: pct,
      });

      if (learner) {
        const nameStr = firstName ? `, ${firstName}` : '';
        const currentDay = currentLesson?.day_number ?? 1;
        const nextDay = nextLesson?.day_number ?? 1;

        if (nextLesson.content_type === 'review') {
          // End of regular modules for this day — run day-end review flow
          await this.runDayEndReview(learner, enrollment.id, nextLesson, currentDay, nameStr);
        } else if (nextDay !== currentDay) {
          // Next lesson is on a different day (shouldn't normally happen without review lesson, but guard)
          await checkedSend(messaging.sendText(learner.phone, {
            text: `🌟 *Day ${currentDay} complete${nameStr}!* Great work today! 🎉`,
          }));
          await delay(3000);
          await checkedSend(messaging.sendText(learner.phone, {
            text: `📅 *Day ${nextDay} starts tomorrow!*\n\nCome back then to continue your learning journey. You're doing amazing! 💪`,
          }));
        } else {
          // Same day — just acknowledge module and offer Next Module button
          await checkedSend(messaging.sendText(learner.phone, {
            text: `✅ *Module ${completedNum} done${nameStr}!* ${pct}% complete 📊`,
          }));
          await delay(5000);
          // Deliver next module directly
          const updatedEnrollment = await db.enrollments.findById(enrollmentId);
          if (updatedEnrollment) {
            await this.sendNextLesson(learner.phone, updatedEnrollment);
          }
        }
      }
    } else {
      // Course complete!
      await db.enrollments.update(enrollmentId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date(),
      });

      if (learner) {
        const TEMPLATES = await getTemplates();
        const nameStr = firstName ? `, ${firstName}` : '';

        // Completion always happens inside the learner's session, so this is plain text with the real
        // name and course. (The old course_complete template was sent with no variables and showed its
        // defaults, "Student" and "Mindset Mastery", plus Browse Courses / Get Certificate buttons.)
        let courseTitle = 'your course';
        try {
          courseTitle = (await db.courses.findById(enrollment.course_id))?.title || 'your course';
        } catch (titleErr) {
          logger.error('Course title lookup failed (non-fatal):', titleErr);
        }
        await checkedSend(messaging.sendText(learner.phone, {
          text: `🎉🎊 *Congratulations${nameStr}!*\n\nYou completed *${courseTitle}*! That's a big achievement! 🏆`,
        }));

        // Issue certificate — generate PDF, send as document
        try {
          const freshLearner = await db.learners.findById(learner.id);
          const { url, fromCache } = await issueCertificate(freshLearner, courseTitle, enrollment.course_id);
          await delay(3000);
          await checkedSend(messaging.sendDocument(learner.phone, {
            documentUrl: url,
            filename: `Ekatra_Certificate_${courseTitle.replace(/\s+/g, '_')}.pdf`,
            caption: fromCache
              ? `📜 *Your certificate${nameStr}:*\n\n_Save or share your Ekatra certificate! 🌍_`
              : `📜 *Your certificate is ready${nameStr}!*\n\n_Share your achievement with the world! 🌍_`,
          }));
        } catch (certErr) {
          logger.error('Certificate generation failed:', certErr);
        }

        // course_feedback is a WhatsApp Flow; senders without it show nothing, so it can be turned off.
        try {
          if (process.env.DISABLE_FEEDBACK_FLOW !== '1') await messaging.sendTemplate(
            learner.phone,
            TEMPLATES.course_feedback,
            { '1': courseTitle },
          );
        } catch (fbErr) {
          logger.error('course_feedback template failed (non-fatal):', fbErr);
        }

        await delay(1000);
        await checkedSend(messaging.sendInteractiveButtons(learner.phone, {
          body: 'What would you like to do next?',
          buttons: [
            { id: 'ask_question', title: 'Ask a Question' },
            { id: 'menu', title: 'New Course' },
          ],
        }));
      }
    }
  }

  /**
   * Run end-of-day review: up to 3 comprehension questions (one at a time), then doubt prompt.
   * Called when next lesson is a 'review' content_type lesson.
   */
  async runDayEndReview(
    learner: any,
    enrollmentId: string,
    reviewLesson: any,
    dayNumber: number,
    nameStr: string,
  ): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    try {
      await checkedSend(messaging.sendText(learner.phone, {
        text: `🌟 *Day ${dayNumber} modules complete${nameStr}!* Let's check what you've learned. 📝`,
      }));
      await delay(3000);

      // Mark review lesson as current
      await db.enrollments.update(enrollmentId, { currentLessonId: reviewLesson.id });

      // The review has up to 3 comprehension questions
      const questions = await db.quiz.findByLesson(reviewLesson.id);

      // Guard: no comprehension questions stored — skip directly to day-end close-out
      if (questions.length === 0) {
        logger.warn(`runDayEndReview: no comprehension questions for review lesson ${reviewLesson.id} — skipping to markDayReviewComplete`);
        await this.markDayReviewComplete(enrollmentId, reviewLesson.id);
        return;
      }

      // One question at a time: the first now, the rest as each answer comes in (see the FSM).
      await delay(1000);
      await this.sendQuiz(learner.phone, questions[0]);
    } catch (err) {
      logger.error(`runDayEndReview failed for enrollment ${enrollmentId}:`, err);
      try {
        await checkedSend(messaging.sendText(learner.phone, {
          text: `Something went wrong with your review. Reply *next* to continue. 🔄`,
        }));
      } catch (_) {
        // best-effort recovery message
      }
    }
  }

  /**
   * Mark review lesson answers and close out the day.
   * Called from FSM when user answers comprehension questions in a review lesson.
   */
  async markDayReviewComplete(enrollmentId: string, reviewLessonId: string): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();

    const enrollment = await db.enrollments.findById(enrollmentId);
    if (!enrollment) return;

    const learner = await db.learners.findById(enrollment.learner_id);
    if (!learner) return;

    const firstName = (learner?.name || '').split(' ')[0] || '';
    const nameStr = firstName ? `, ${firstName}` : '';

    // Complete review lesson progress
    const progress = await db.lessonProgress.find(enrollmentId, reviewLessonId);
    if (progress) {
      await db.lessonProgress.update(progress.id, { status: 'completed', completedAt: new Date() });
    }

    // Find next real lesson (after review)
    const lessons = await db.lessons.findByCourse(enrollment.course_id);
    const reviewIdx = lessons.findIndex((l: any) => l.id === reviewLessonId);
    const nextLesson = lessons[reviewIdx + 1];

    if (nextLesson) {
      // Advance to next lesson (first module of next day)
      const pct = Math.round((reviewIdx / lessons.length) * 100);
      await db.enrollments.update(enrollmentId, {
        currentLessonId: nextLesson.id,
        progress: pct,
      });

      // Offer doubt prompt before signing off for the day
      await checkedSend(messaging.sendInteractiveButtons(learner.phone, {
        body: `Any doubts before we wrap up Day ${nextLesson.day_number - 1}? 🤔`,
        buttons: [
          { id: 'doubt_yes', title: 'Yes, I have a doubt' },
          { id: 'doubt_no', title: 'No, all good!' },
        ],
      }));
    } else {
      // Review was the last lesson — course complete
      await this.markLessonComplete(enrollmentId, reviewLessonId);
    }
  }

  /**
   * Send lessons to all enrolled learners for a schedule
   */
  async executeSchedule(scheduleId: string): Promise<{ sent: number; failed: number }> {
    const db = await getDb();

    const schedule = await db.schedules.findById(scheduleId);
    if (!schedule || !schedule.is_active) {
      return { sent: 0, failed: 0 };
    }

    const enrollments = await db.enrollments.getActiveForCourse(schedule.course_id);
    let sent = 0;
    let failed = 0;

    // Process in batches of 10 concurrent sends.
    // WhatsApp Cloud API throughput limit is ~80 msg/s; 10 concurrent with network
    // latency stays safely under that while cutting wall-clock time by ~10x vs serial.
    const CONCURRENCY = 10;
    // Illustrations are collected and sent after the lesson batches (one
    // generation per lesson via the cache, uploads with bounded concurrency) so
    // the job doesn't report completion with image sends still in flight.
    const illustrations: Array<() => Promise<void>> = [];
    const deferIllustration = (send: () => Promise<void>) => { illustrations.push(send); };

    for (let i = 0; i < enrollments.length; i += CONCURRENCY) {
      const batch = enrollments.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (enrollment) => {
          const learner = await db.learners.findById(enrollment.learner_id);
          if (!learner || learner.status !== 'active') return 'skipped';
          const success = await this.sendNextLesson(learner.phone, enrollment, { deferIllustration });
          return success ? 'sent' : 'failed';
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value === 'sent') sent++;
          else if (result.value === 'failed') failed++;
        } else {
          logger.error('Error sending lesson in batch:', result.reason);
          failed++;
        }
      }

      // Brief pause between batches — keeps burst rate well under API limits
      if (i + CONCURRENCY < enrollments.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    for (let i = 0; i < illustrations.length; i += CONCURRENCY) {
      await Promise.allSettled(illustrations.slice(i, i + CONCURRENCY).map(send => send()));
    }

    logger.info(`Schedule ${scheduleId}: Sent ${sent}, Failed ${failed}`);
    return { sent, failed };
  }
}
