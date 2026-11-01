import { db } from '@ekatra/database';
import { logger } from '../lib/logger.js';
import { MessageHandler } from './messageHandler.js';
import { processCloudApiReceiptEvent, type CloudApiReceiptEvent } from './cloudApiReceipts.js';

interface StoredCloudApiPayload {
  payload: Record<string, unknown>;
  context?: CloudApiReceiptEvent['context'];
}

let running = false;

export async function recoverCloudApiReceipts(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const receipts = await db.webhookReceipts.claimRecoverable({ provider: 'cloudapi' });
    if (receipts.length === 0) return 0;

    const messageHandler = new MessageHandler();
    for (const receipt of receipts) {
      try {
        const stored = receipt.payload as StoredCloudApiPayload;
        await processCloudApiReceiptEvent({
          externalEventId: receipt.external_event_id,
          eventType: receipt.event_type as CloudApiReceiptEvent['eventType'],
          payload: stored.payload,
          context: stored.context ?? {},
        }, messageHandler);
        await db.webhookReceipts.markProcessed(receipt.id);
      } catch (error) {
        // Leave the receipt retryable (lock contention included) — it is
        // re-claimed after backoff. A failure to mark it must not abort the
        // rest of the claimed batch; the lease expiry reclaims it instead.
        logger.error(`Webhook recovery failed for receipt ${receipt.id}:`, error);
        try {
          await db.webhookReceipts.markFailed(receipt.id, error);
        } catch (markError) {
          logger.error(`Unable to mark webhook receipt ${receipt.id} failed:`, markError);
        }
      }
    }
    return receipts.length;
  } finally {
    running = false;
  }
}

export function startWebhookRecovery(intervalMs = 15_000): () => void {
  const boundedInterval = Math.max(5_000, intervalMs);
  const run = () => recoverCloudApiReceipts().catch(error => logger.error('Webhook recovery scan failed:', error));
  void run();
  const timer = setInterval(run, boundedInterval);
  timer.unref();
  logger.info(`Webhook receipt recovery enabled (${boundedInterval}ms interval)`);
  return () => clearInterval(timer);
}
