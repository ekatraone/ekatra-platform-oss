/**
 * WhatsApp Webhook Handler
 * 
 * Handles incoming WhatsApp messages via Cloud API, WATI, and Twilio
 */

import { Router, Request, Response } from 'express';
import { requireWebhookProvider, verifyMetaSignature, verifySharedSecret } from '../middleware/webhookSecurity.js';
import twilio from 'twilio';
import { LearnerBusyError, MessageHandler } from '../services/messageHandler.js';
import { logger } from '../lib/logger.js';
import { markdownToWhatsApp } from '../lib/whatsappFormatter.js';
import {
  extractCloudApiReceiptEvents,
  processCloudApiReceiptEvent,
  type CloudApiReceiptEvent,
} from '../services/cloudApiReceipts.js';

export { markdownToWhatsApp }; // re-export for service use

export const webhookRouter: Router = Router();
const messageHandler = new MessageHandler();

// Lazy import for database
const getDb = () => import('@ekatra/database').then(m => m.db);

/**
 * Webhook verification (GET)
 * Meta sends this to verify the webhook URL
 */
webhookRouter.get('/whatsapp', requireWebhookProvider('cloudapi'), (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  logger.info('Webhook verification attempt');

  if (mode === 'subscribe' && typeof challenge === 'string' && verifySharedSecret(token, process.env.META_WEBHOOK_VERIFY_TOKEN)) {
    logger.info('✅ Webhook verified');
    return res.status(200).send(challenge);
  }

  logger.error('❌ Webhook verification failed');
  return res.sendStatus(403);
});

/**
 * Telegram webhook (POST)
 * Optional shared-secret check via X-Telegram-Bot-Api-Secret-Token
 * (set the same value in setWebhook's secret_token and TELEGRAM_WEBHOOK_SECRET).
 */
webhookRouter.post('/telegram', async (req: Request, res: Response) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_POLLING === 'true') return res.sendStatus(404);
  if (!verifySharedSecret(req.headers['x-telegram-bot-api-secret-token'], expected)) {
    logger.error('Invalid Telegram webhook secret');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const { handleTelegramUpdate } = await import('../services/telegramGateway.js');
    await handleTelegramUpdate(req.body);
  } catch (error) {
    logger.error('Error processing Telegram webhook:', error);
  }
});

/**
 * Incoming messages (POST)
 * Meta sends messages here
 */
webhookRouter.post('/whatsapp', requireWebhookProvider('cloudapi'), async (req: Request, res: Response) => {
  // Verify signature
  const signature = req.headers['x-hub-signature-256'] as string;
  if (!verifyMetaSignature(req.rawBody, signature, process.env.META_APP_SECRET)) {
    logger.error('Invalid webhook signature');
    return res.sendStatus(401);
  }

  // Persist and claim each provider event before acknowledging the batch. If the
  // database is unavailable, return 503 so Meta retries instead of losing it.
  const events = extractCloudApiReceiptEvents(req.body);
  const claimed: Array<{ receiptId: string; event: CloudApiReceiptEvent }> = [];
  try {
    const db = await getDb();
    for (const event of events) {
      const receipt = await db.webhookReceipts.receiveAndClaim({
        provider: 'cloudapi',
        externalEventId: event.externalEventId,
        eventType: event.eventType,
        payload: { payload: event.payload, context: event.context },
      });
      if (receipt.claimed) claimed.push({ receiptId: receipt.id, event });
    }
  } catch (error) {
    logger.error('Unable to persist webhook receipt:', error);
    return res.sendStatus(503);
  }

  res.sendStatus(200);

  // Process after acknowledgment. processCloudApiReceiptEvent rejects when the
  // event was not handled (error, or learner lock busy), so only real success is
  // marked processed; anything else stays durable and claimable by a provider
  // retry or the recovery worker.
  for (const item of claimed) {
    try {
      await processCloudApiReceiptEvent(item.event, messageHandler);
      const db = await getDb();
      await db.webhookReceipts.markProcessed(item.receiptId);
    } catch (error) {
      if (error instanceof LearnerBusyError) {
        logger.warn(`Webhook receipt ${item.receiptId} deferred: ${error.message}`);
      } else {
        logger.error(`Error processing webhook receipt ${item.receiptId}:`, error);
      }
      try {
        const db = await getDb();
        await db.webhookReceipts.markFailed(item.receiptId, error);
      } catch (markError) {
        logger.error(`Unable to mark webhook receipt ${item.receiptId} failed:`, markError);
      }
    }
  }
});

/**
 * WATI-style webhook (for backward compatibility during migration)
 */
webhookRouter.post('/wati', async (req: Request, res: Response) => {
  if (!process.env.WATI_WEBHOOK_SECRET) return res.sendStatus(404);
  if (!verifySharedSecret(req.headers['x-webhook-secret'], process.env.WATI_WEBHOOK_SECRET)) return res.sendStatus(401);
  try {
    const { waId, text, senderName, type, listReply, button } = req.body;
    
    logger.info(`📱 WATI webhook from ${waId}: ${text}`);

    // Convert to standard format
    const message = {
      from: waId,
      name: senderName,
      type: type || 'text',
      text: text,
      listReplyId: listReply?.id,
      buttonPayload: button?.payload,
      timestamp: new Date().toISOString()
    };

    await messageHandler.handle(message);
    
    res.status(200).send('OK');
  } catch (error) {
    logger.error('Error in WATI webhook:', error);
    res.status(500).send('Error');
  }
});

/**
 * Process message status updates (delivered, read, failed, undelivered, sent, queued, etc.)
 * Called from both the Cloud API webhook and the Twilio webhook handler.
 *
 * @param status.id               The WhatsApp/Twilio message SID
 * @param status.status           One of: queued, sending, sent, delivered, read, undelivered, failed
 * @param status.timestamp        Unix epoch string (Cloud API) or ISO string (Twilio)
 * @param status.metadata         Extra fields: error_code, channel_error, etc.
 */
async function processStatusUpdate(status: {
  id: string;
  status: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  let ts: Date;
  if (status.timestamp) {
    // Cloud API sends unix epoch; Twilio sends ISO or RFC2822 string
    const asNum = parseInt(status.timestamp, 10);
    ts = isNaN(asNum) ? new Date(status.timestamp) : new Date(asNum * 1000);
  } else {
    ts = new Date();
  }
  const db = await getDb();
  await db.messageLog.updateStatus(status.id, status.status, ts, status.metadata);
}


// Export webhook router (already exported as const above)

/**
 * Twilio WhatsApp webhook
 * POST /api/webhooks/twilio
 *
 * Handles two event types from the same endpoint:
 *
 * 1. Inbound message (has From + Body/ButtonPayload):
 *    From=whatsapp:+919900000050, Body=Hello, WaId=919900000050
 *    ButtonPayload=confirm_yes, ButtonText=Yes start!
 *
 * 2. Status callback (has MessageStatus + MessageSid):
 *    MessageSid=SMxxx, MessageStatus=delivered|read|failed|undelivered|sent|queued
 *    ErrorCode=30008 (if failed/undelivered)
 *    ChannelStatusMessage=<WhatsApp error string> (if failed)
 *    EventType=READ (WhatsApp read receipt, same as status=read)
 */
webhookRouter.post('/twilio', requireWebhookProvider('twilio'), async (req: Request, res: Response) => {
  if (!process.env.TWILIO_AUTH_TOKEN) return res.sendStatus(401);
  // Validate Twilio signature using official SDK
  if (process.env.TWILIO_AUTH_TOKEN) {
    const twilioSig = req.headers['x-twilio-signature'] as string;
    const baseUrl = process.env.WEBHOOK_BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get('host')}`);
    const url = `${baseUrl}${req.originalUrl}`;
    const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSig, url, req.body);
    if (!valid) {
      logger.warn('❌ Invalid Twilio signature — rejecting request');
      return res.sendStatus(403);
    }
  }

  // Twilio expects a TwiML response or empty 200
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const body = req.body;

    // ── Status callback (MessageStatus present) ──────────────────────────────
    if (body.MessageStatus) {
      // EventType=READ is WhatsApp's read receipt — treat as 'read' status
      const status = body.EventType === 'READ' ? 'read' : body.MessageStatus;
      const metadata: Record<string, any> = {};
      if (body.ErrorCode) metadata.error_code = body.ErrorCode;
      if (body.ChannelStatusMessage) metadata.channel_error = body.ChannelStatusMessage;

      logger.info(`📬 Twilio status: ${body.MessageSid} → ${status}${
        body.ErrorCode ? ` (error ${body.ErrorCode}: ${body.ChannelStatusMessage || ''})` : ''
      }`);

      await processStatusUpdate({
        id: body.MessageSid,
        status,
        timestamp: body.Timestamp || undefined,
        metadata,
      });
      return;
    }

    // ── Inbound message ──────────────────────────────────────────────────────
    const rawFrom: string = body.From || '';
    const waId: string = body.WaId || rawFrom.replace(/^whatsapp:\+?/, '');
    const text: string = body.Body || '';
    const profileName: string = body.ProfileName || 'User';
    const buttonPayload: string | undefined = body.ButtonPayload || undefined;

    if (!waId || waId.length < 6) {
      logger.warn('Twilio webhook: missing or invalid sender phone — ignoring');
      return;
    }

    logger.info(`📱 Twilio webhook from ${waId}: "${(text || buttonPayload || '').substring(0, 60)}"`);

    await messageHandler.handle({
      from: waId,
      name: profileName,
      type: buttonPayload ? 'button' : 'text',
      text: buttonPayload ? undefined : text,
      buttonPayload,
    });
  } catch (err) {
    logger.error('Error processing Twilio webhook:', err);
  }
});
