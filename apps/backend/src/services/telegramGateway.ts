/**
 * Telegram Gateway
 *
 * Bridges Telegram updates into the channel-agnostic message pipeline.
 * Learners arriving via Telegram are addressed as `tg:<chat_id>`, which the
 * messaging package routes to the TelegramProvider instead of WhatsApp.
 *
 * Two ingestion modes:
 *  - Webhook: POST /api/webhooks/telegram (production, needs public HTTPS URL)
 *  - Long polling: getUpdates loop (local dev — no public URL required).
 *    Enabled with TELEGRAM_POLLING=true.
 */

import { logger } from '../lib/logger.js';
import { MessageHandler } from './messageHandler.js';

const messageHandler = new MessageHandler();

const botUrl = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function handleTelegramUpdate(update: any): Promise<void> {
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      // Ack so the client stops showing the loading spinner
      fetch(`${botUrl()}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      }).catch(() => {});

      await messageHandler.handle({
        from: `tg:${cq.message?.chat?.id ?? cq.from.id}`,
        name: [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || cq.from.username,
        type: 'interactive',
        // FSM treats WhatsApp button and list replies via these ids — callback_data carries the same id
        buttonReplyId: cq.data,
        listReplyId: cq.data,
        timestamp: String(cq.message?.date ?? Math.floor(Date.now() / 1000)),
      });
      return;
    }

    const msg = update.message;
    if (!msg?.chat?.id) return;

    await messageHandler.handle({
      from: `tg:${msg.chat.id}`,
      name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username,
      type: 'text',
      // "/start" is Telegram's entry command — map it to the FSM's greeting keyword
      text: msg.text === '/start' ? 'hi' : msg.text,
      timestamp: String(msg.date ?? Math.floor(Date.now() / 1000)),
    });
  } catch (error) {
    logger.error('Error handling Telegram update:', error);
  }
}

let polling = false;

export function startTelegramPolling(): void {
  if (polling || !process.env.TELEGRAM_BOT_TOKEN) return;
  polling = true;

  let offset = 0;
  const loop = async () => {
    while (polling) {
      try {
        // allowed_updates persists server-side from earlier setWebhook/getUpdates calls,
        // so request message + callback_query explicitly or button taps may never arrive
        const res = await fetch(
          `${botUrl()}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,
          { signal: AbortSignal.timeout(35_000) },
        );
        const data: any = await res.json();
        if (!data.ok) {
          logger.warn(`Telegram polling error: ${data.description}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const update of data.result ?? []) {
          offset = update.update_id + 1;
          await handleTelegramUpdate(update);
        }
      } catch (error: any) {
        if (error.name !== 'TimeoutError') logger.warn(`Telegram polling failed: ${error.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  loop();
  logger.info('✅ Telegram: long polling started');
}

export function stopTelegramPolling(): void {
  polling = false;
}
