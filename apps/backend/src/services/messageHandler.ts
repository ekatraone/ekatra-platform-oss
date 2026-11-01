/**
 * Message Handler Service
 *
 * Thin router: resolves the learner record, logs each message,
 * then delegates all conversation logic to ConversationFSM.
 */

import { logger } from '../lib/logger.js';
import { conversationFSM } from '../flows/conversationFSM.js';
import { acquireLearnerLock, acquireLock } from '../lib/redis.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);
const getMessaging = () => import('@ekatra/messaging').then((m) => m.messaging);

interface IncomingMessage {
  from: string;
  name?: string;
  type: string;
  text?: string;
  timestamp?: string;
  mediaId?: string;
  buttonPayload?: string;
  listReplyId?: string;
  buttonReplyId?: string;
}

/**
 * Thrown (only in rethrow mode) when another message from the same learner is
 * still being processed. The message was NOT handled and should be retried.
 */
export class LearnerBusyError extends Error {
  constructor(learnerId: string) {
    super(`Learner ${learnerId} is busy — message deferred for retry`);
    this.name = 'LearnerBusyError';
  }
}

/** Button / list / interactive replies (as opposed to free text or media). */
export function isInteractiveReply(message: Pick<IncomingMessage, 'type' | 'buttonPayload' | 'buttonReplyId' | 'listReplyId'>): boolean {
  return Boolean(
    message.buttonPayload ||
    message.buttonReplyId ||
    message.listReplyId ||
    message.type === 'button' ||
    message.type === 'interactive',
  );
}

export interface HandleOptions {
  /**
   * Durable callers (Cloud API webhook receipts) pass true so a message that
   * failed before reaching the FSM (or free text deferred by lock contention)
   * rejects instead of resolving, and the receipt stays retryable. Legacy callers (WATI, Twilio, Telegram) keep the default
   * log-and-swallow behaviour.
   */
  rethrow?: boolean;
}

export class MessageHandler {
  async handle(message: IncomingMessage, options: HandleOptions = {}): Promise<void> {
    let dispatched = false;
    try {
      const db = await getDb();
      const { from, name, type, text, buttonPayload, listReplyId, buttonReplyId, mediaId } = message;

      logger.info(`📱 Message from ${from}: ${text || buttonPayload || listReplyId || type}`);

      // Resolve or create the learner record
      let learner =
        (await db.learners.findByWhatsAppId(from)) ||
        (await db.learners.findByPhone(from));

      const isNewLearner = !learner;
      if (!learner) {
        learner = await this.createLearner(from, name);
        if (!learner) throw new Error('Unable to create learner: no default organisation');
      }

      // ── Per-learner lock — serialises concurrent inbound messages so the FSM
      // never races. If another message from this learner is already being processed,
      // this one is not handled. Every provider has already been acknowledged with
      // 200, so nothing retries it automatically. Button/list taps are dropped: they
      // are usually mashes of the same button ("next" has no staleness check), and
      // replaying them later would skip lessons or land in a different state. Free
      // text and media are deferred in rethrow mode — LearnerBusyError marks the
      // durable webhook receipt failed so the recovery worker replays it after
      // backoff. Legacy callers drop everything.
      const release = await acquireLearnerLock(learner.id, 30);
      if (!release) {
        const defer = options.rethrow && !isInteractiveReply(message);
        logger.warn(`⚠️  Learner ${learner.id} lock held — ${defer ? 'deferring' : 'dropping'} concurrent message`);
        // Give feedback for the tap that got dropped instead of silence — but only
        // once per burst (8s), so mashing a button doesn't flood the chat with notices.
        const canNotify = await acquireLock(`learner-busy-notice:${learner.id}`, 8);
        if (canNotify) {
          const messaging = await getMessaging();
          await messaging
            .sendText(from, { text: '⏳ Still working on your last message — one sec!' })
            .catch(() => {});
        }
        if (defer) throw new LearnerBusyError(learner.id);
        return;
      }

      try {
        // Persist inbound message for audit / analytics, correlating to last outbound
        const lastOutbound = await db.messageLog.findMostRecentOutbound(learner.id);
        const responseTimeMs = lastOutbound
          ? Date.now() - new Date(lastOutbound.created_at).getTime()
          : undefined;

        await db.messageLog.create({
          learnerId: learner.id,
          direction: 'inbound',
          messageType: type,
          content: text || buttonPayload || listReplyId || buttonReplyId || '',
          metadata: { mediaId },
          inReplyTo: lastOutbound?.id,
          responseTimeMs,
        });

        // For brand-new learners, createLearner() already sent the welcome and
        // primed the FSM to topic_input — don't re-process the triggering message
        // (which would incorrectly be accepted as the topic).
        // From here on the message counts as handled: failures inside the FSM
        // may leave side effects half-applied (transitions, sends), so they are
        // logged, not rethrown — a replay would repeat them.
        dispatched = true;
        if (isNewLearner) return;

        // All routing is now handled by the FSM
        await conversationFSM.process(learner, message);
      } finally {
        try {
          await release();
        } catch (releaseErr) {
          // The lock expires on its own TTL; never replay a processed message for this.
          logger.error(`Failed to release learner lock for ${learner.id}:`, releaseErr);
        }
      }
    } catch (error) {
      if (error instanceof LearnerBusyError) throw error;
      logger.error('Error handling message:', error);
      if (options.rethrow && !dispatched) throw error;
    }
  }

  private async createLearner(phone: string, name?: string): Promise<any> {
    const db = await getDb();
    const messaging = await getMessaging();

    logger.info(`👤 New learner: ${phone}`);

    const org = await db.organizations.getDefault();
    if (!org) {
      logger.error('No default organisation found');
      return null;
    }

    const learner = await db.learners.create({
      organizationId: org.id,
      phone,
      whatsappId: phone,
      name: name || 'Friend',
      language: 'en',
    });

    // Welcome message — FSM will take over from here on the next message
    await messaging.sendText(phone, {
      text: `Welcome to *Ekatra*! 🎉\n\nI'm *Alfred*, your personal AI tutor.\n\nType anything to get started — I'll help you learn any topic in bite-sized lessons, right here on WhatsApp! 📱`,
    });

    // Fire student_registration template so Twilio registers the subscriber
    try {
      const { TWILIO_TEMPLATES } = await import('@ekatra/messaging');
      await messaging.sendTemplate(phone, TWILIO_TEMPLATES.student_registration);
    } catch (regErr) {
      logger.error('student_registration template failed (non-fatal):', regErr);
    }

    // Prime the FSM to topic_input immediately
    await conversationFSM.process(learner, {
      from: phone,
      type: 'text',
      text: 'start',
    });

    return learner;
  }

  // ── Legacy helpers kept for backward-compat with direct invocations ────────

  private async handleNewUser(phone: string, name?: string): Promise<any> {
    return this.createLearner(phone, name);
  }

  private async handleCourseMessage(_learner: any, _enrollment: any, _message: any) {
    // Delegated to FSM — kept as a no-op for compatibility
  }

  private async handleMenuMessage(_learner: any, _message: any) {
    // Delegated to FSM — kept as a no-op for compatibility
  }

}

