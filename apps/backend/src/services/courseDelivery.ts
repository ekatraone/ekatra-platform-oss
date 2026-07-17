/**
 * Course Delivery Service
 * 
 * Handles sending course lessons to learners via WhatsApp
 * Uses lazy imports to avoid circular dependencies
 */

import { logger } from '../lib/logger.js';
import { markdownToWhatsApp } from '../lib/whatsappFormatter.js';
import { issueCertificate } from './certificateService.js';
import { modelRouter } from '../lib/modelRouter.js';

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

// Lazy imports
const getDb = () => import('@ekatra/database').then(m => m.db);
const getMessaging = () => import('@ekatra/messaging').then(m => m.messaging);
const getTemplates = () => import('@ekatra/messaging').then(m => m.TWILIO_TEMPLATES);

export class CourseDeliveryService {
  
  /**
   * Send next lesson to learner
   */
  async sendNextLesson(phone: string, enrollment: any): Promise<boolean> {
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
        await messaging.sendText(phone, {
          text: "⚠️ Something went wrong loading your lesson. Please type *next* to try again.",
        });
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

      await messaging.sendText(phone, {
        text: `${headerLine}\n${progressLine}${nameLine}`,
      });

      // Deliberate pause so the header lands before the content
      await delay(1200);

      // Lesson title + content
      await messaging.sendText(phone, {
        text: `*${lesson.title}*\n\n${markdownToWhatsApp(lesson.content)}`,
      });

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
        await messaging.sendInteractiveButtons(phone, {
          body: `Module ${lessonNum} delivered ✅\n\nTake your time. Tap *Next Module* when ready!`,
          buttons: [
            { id: 'next', title: 'Next Module' },
            { id: 'ask_question', title: 'Ask a Question' },
          ],
        });
      }

      // Illustration — sent after the button/quiz so the learner can act
      // immediately instead of waiting ~15-20s of dead air for image generation.
      // Deliberately not awaited: the per-learner lock is released as soon as
      // sendNextLesson returns, so a slow image call must not hold it open —
      // that was exactly what made rapid button taps look "stuck" (a tap
      // arriving mid-generation found the lock held and was silently dropped).
      // Telegram only today — WhatsApp needs the Meta media-upload API.
      import('@ekatra/messaging').then(async ({ isTelegramRecipient }) => {
        if (!isTelegramRecipient(phone) || !modelRouter.capabilities().image) return;
        try {
          const imagePrompt = buildIllustrationPrompt(lesson);
          const image = await modelRouter.generateImage(imagePrompt, { quality: 'low' });
          await messaging.sendImageBuffer(phone, image, lesson.title);
        } catch (err: any) {
          logger.warn('Lesson illustration failed, continuing without it:', err);
        }
      });

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
          await messaging.sendImage(phone, { imageUrl: lesson.media_url, caption: lesson.content || '' });
        } else {
          await messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) });
        }
        break;
      case 'video':
        if (lesson.media_url) {
          await messaging.sendVideo(phone, { videoUrl: lesson.media_url, caption: lesson.content || '' });
        } else {
          await messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) });
        }
        break;
      case 'document':
        if (lesson.media_url) {
          await messaging.sendDocument(phone, { documentUrl: lesson.media_url, filename: lesson.title, caption: lesson.content || '' });
        } else {
          await messaging.sendText(phone, { text: markdownToWhatsApp(lesson.content) });
        }
        break;
      case 'audio':
        if (lesson.media_url) {
          await messaging.sendAudio(phone, lesson.media_url);
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
  private async sendQuiz(phone: string, question: any): Promise<void> {
    const messaging = await getMessaging();
    
    if (question.question_type === 'multiple_choice' && question.options) {
      const options = question.options as string[];
      // Put options in body text, use A/B/C as button labels.
      // When user taps a button, Twilio sends Body="A" (the title),
      // which the FSM maps to quiz_<questionId>_A using the active lesson.
      const optionsText = options
        .slice(0, 3)
        .map((opt: string, idx: number) => `${String.fromCharCode(65 + idx)}) ${opt}`)
        .join('\n');

      await messaging.sendInteractiveButtons(phone, {
        body: `${question.question}\n\n${optionsText}`,
        buttons: options.slice(0, 3).map((_: string, idx: number) => ({
          id: String.fromCharCode(65 + idx),
          title: String.fromCharCode(65 + idx),
        })),
      });
    } else {
      await messaging.sendText(phone, {
        text: `❓ ${question.question}\n\n_Reply with your answer_`
      });
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
          await messaging.sendText(learner.phone, {
            text: `🌟 *Day ${currentDay} complete${nameStr}!* Great work today! 🎉`,
          });
          await delay(3000);
          await messaging.sendText(learner.phone, {
            text: `📅 *Day ${nextDay} starts tomorrow!*\n\nCome back then to continue your learning journey. You're doing amazing! 💪`,
          });
        } else {
          // Same day — just acknowledge module and offer Next Module button
          await messaging.sendText(learner.phone, {
            text: `✅ *Module ${completedNum} done${nameStr}!* ${pct}% complete 📊`,
          });
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

        // Use pre-approved course_complete template — delivers even outside session window
        const templateResult = await messaging.sendTemplate(
          learner.phone,
          TEMPLATES.course_complete,
        );

        if (!templateResult.success) {
          await messaging.sendText(learner.phone, {
            text: `🎉🎊 *Congratulations${nameStr}!*\n\nYou've completed the entire course! That's a big achievement! 🏆`,
          });
        }

        // Issue certificate — generate PDF, send as document
        let courseTitle = 'your course';
        try {
          const freshLearner = await db.learners.findById(learner.id);
          const courseForCert = await db.courses.findById(enrollment.course_id);
          courseTitle = courseForCert?.title || 'Course';
          const { url, fromCache } = await issueCertificate(freshLearner, courseTitle);
          await delay(3000);
          await messaging.sendDocument(learner.phone, {
            documentUrl: url,
            filename: `Ekatra_Certificate_${courseTitle.replace(/\s+/g, '_')}.pdf`,
            caption: fromCache
              ? `📜 *Your certificate${nameStr}:*\n\n_Save or share your Ekatra certificate! 🌍_`
              : `📜 *Your certificate is ready${nameStr}!*\n\n_Share your achievement with the world! 🌍_`,
          });
        } catch (certErr) {
          logger.error('Certificate generation failed:', certErr);
        }

        // Send course_feedback template
        try {
          await messaging.sendTemplate(
            learner.phone,
            TEMPLATES.course_feedback,
            { '1': courseTitle },
          );
        } catch (fbErr) {
          logger.error('course_feedback template failed (non-fatal):', fbErr);
        }

        await delay(1000);
        await messaging.sendInteractiveButtons(learner.phone, {
          body: 'What would you like to do next?',
          buttons: [
            { id: 'ask_question', title: 'Ask a Question' },
            { id: 'menu', title: 'New Course' },
          ],
        });
      }
    }
  }

  /**
   * Run end-of-day review: 3 comprehension questions, then doubt prompt.
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
      await messaging.sendText(learner.phone, {
        text: `🌟 *Day ${dayNumber} modules complete${nameStr}!* Let's check what you've learned. 📝`,
      });
      await delay(3000);

      // Mark review lesson as current
      await db.enrollments.update(enrollmentId, { currentLessonId: reviewLesson.id });

      // Send the 3 comprehension questions sequentially
      const questions = await db.quiz.findByLesson(reviewLesson.id);

      // Guard: no comprehension questions stored — skip directly to day-end close-out
      if (questions.length === 0) {
        logger.warn(`runDayEndReview: no comprehension questions for review lesson ${reviewLesson.id} — skipping to markDayReviewComplete`);
        await this.markDayReviewComplete(enrollmentId, reviewLesson.id);
        return;
      }

      for (let i = 0; i < Math.min(questions.length, 3); i++) {
        await delay(i === 0 ? 1000 : 5000);
        await this.sendQuiz(learner.phone, questions[i]);
      }
    } catch (err) {
      logger.error(`runDayEndReview failed for enrollment ${enrollmentId}:`, err);
      try {
        await messaging.sendText(learner.phone, {
          text: `Something went wrong with your review. Reply *next* to continue. 🔄`,
        });
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
      await messaging.sendInteractiveButtons(learner.phone, {
        body: `Any doubts before we wrap up Day ${nextLesson.day_number - 1}? 🤔`,
        buttons: [
          { id: 'doubt_yes', title: 'Yes, I have a doubt' },
          { id: 'doubt_no', title: 'No, all good!' },
        ],
      });
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

    for (let i = 0; i < enrollments.length; i += CONCURRENCY) {
      const batch = enrollments.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (enrollment) => {
          const learner = await db.learners.findById(enrollment.learner_id);
          if (!learner || learner.status !== 'active') return 'skipped';
          const success = await this.sendNextLesson(learner.phone, enrollment);
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

    logger.info(`Schedule ${scheduleId}: Sent ${sent}, Failed ${failed}`);
    return { sent, failed };
  }
}
