import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCloudApiReceiptEvents, processCloudApiReceiptEvent } from '../cloudApiReceipts.js';

describe('extractCloudApiReceiptEvents', () => {
  it('creates stable, independent receipt identities for messages and statuses', () => {
    const events = extractCloudApiReceiptEvents({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'phone-1' },
        contacts: [{ wa_id: '919900000000' }],
        messages: [{ id: 'wamid.1', from: '919900000000', type: 'text', text: { body: 'Hi' } }],
        statuses: [{ id: 'wamid.out', status: 'delivered', timestamp: '1710000000' }],
      } }] }],
    });

    assert.deepEqual(events.map(({ externalEventId, eventType }) => ({ externalEventId, eventType })), [
      { externalEventId: 'wamid.1', eventType: 'message' },
      { externalEventId: 'wamid.out:delivered:1710000000', eventType: 'status' },
    ]);
    assert.deepEqual(events[0].context.metadata, { phone_number_id: 'phone-1' });
  });

  it('rejects unsupported bodies and events without provider identifiers', () => {
    assert.deepEqual(extractCloudApiReceiptEvents(null), []);
    assert.deepEqual(extractCloudApiReceiptEvents({ object: 'other' }), []);
    assert.deepEqual(extractCloudApiReceiptEvents({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ type: 'text' }] } }] }],
    }), []);
  });

  it('replays a stored inbound message through the normal message handler contract', async () => {
    const handled: unknown[] = [];
    await processCloudApiReceiptEvent({
      externalEventId: 'wamid.replay',
      eventType: 'message',
      payload: {
        id: 'wamid.replay',
        from: '919900000000',
        timestamp: '1710000000',
        type: 'interactive',
        interactive: { button_reply: { id: 'next_lesson' } },
      },
      context: { contacts: [{ wa_id: '919900000000', profile: { name: 'Learner' } }] },
    }, { handle: async message => { handled.push(message); } });

    assert.deepEqual(handled, [{
      from: '919900000000',
      name: 'Learner',
      timestamp: '1710000000',
      type: 'interactive',
      text: undefined,
      mediaId: undefined,
      buttonPayload: undefined,
      listReplyId: undefined,
      buttonReplyId: 'next_lesson',
    }]);
  });
});
