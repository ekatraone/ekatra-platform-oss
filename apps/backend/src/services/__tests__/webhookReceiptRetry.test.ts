import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from '@ekatra/database';
import { cloudApiStatusMetadata, processCloudApiReceiptEvent } from '../cloudApiReceipts.js';
import { LearnerBusyError, MessageHandler } from '../messageHandler.js';
import { recoverCloudApiReceipts } from '../webhookRecovery.js';

const messageEvent = (id: string) => ({
  externalEventId: id,
  eventType: 'message' as const,
  payload: { id, from: '919900000000', type: 'text', text: { body: 'Hi' } },
  context: {},
});

describe('durable receipt processing surfaces unhandled messages', () => {
  it('asks the handler to rethrow and propagates its failure', async () => {
    const seen: unknown[] = [];
    await assert.rejects(processCloudApiReceiptEvent(messageEvent('wamid.busy'), {
      handle: async (_message, options) => {
        seen.push(options);
        throw new LearnerBusyError('learner-1');
      },
    }), LearnerBusyError);
    assert.deepEqual(seen, [{ rethrow: true }]);
  });

  it('maps Meta status errors into message_log metadata', async t => {
    const updates: unknown[][] = [];
    t.mock.method(db.messageLog, 'updateStatus', async (...args: unknown[]) => { updates.push(args); return null; });
    await processCloudApiReceiptEvent({
      externalEventId: 'wamid.out:failed:1710000000',
      eventType: 'status',
      payload: {
        id: 'wamid.out', status: 'failed', timestamp: '1710000000',
        errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }],
      },
      context: {},
    }, { handle: async () => undefined });
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0][3], {
      error_code: 131047, channel_error: 'Re-engagement message', error_details: 'More than 24 hours',
    });
    assert.equal(cloudApiStatusMetadata({ id: 'x', status: 'delivered' }), undefined);
  });
});

describe('recoverCloudApiReceipts', () => {
  it('leaves failed/deferred receipts retryable and keeps going when markFailed throws', async t => {
    t.mock.method(db.webhookReceipts, 'claimRecoverable', async () => [
      { id: 'r1', provider: 'cloudapi', external_event_id: 'wamid.1', event_type: 'message', attempts: 1, payload: { payload: messageEvent('wamid.1').payload } },
      { id: 'r2', provider: 'cloudapi', external_event_id: 'wamid.2', event_type: 'message', attempts: 1, payload: { payload: messageEvent('wamid.2').payload } },
    ]);
    const processed: string[] = [];
    const failed: string[] = [];
    t.mock.method(db.webhookReceipts, 'markProcessed', async (id: string) => { processed.push(id); });
    t.mock.method(db.webhookReceipts, 'markFailed', async (id: string) => {
      failed.push(id);
      throw new Error('db down');
    });
    let call = 0;
    t.mock.method(MessageHandler.prototype, 'handle', async () => {
      call++;
      if (call === 1) throw new LearnerBusyError('learner-1');
    });

    assert.equal(await recoverCloudApiReceipts(), 2);
    assert.deepEqual(failed, ['r1']);
    assert.deepEqual(processed, ['r2']);
  });
});
