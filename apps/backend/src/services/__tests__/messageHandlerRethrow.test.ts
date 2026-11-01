import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// No Redis in unit tests: learner locks degrade to always-acquired.
delete process.env.REDIS_URL;

const { db } = await import('@ekatra/database');
const { conversationFSM } = await import('../../flows/conversationFSM.js');
const { MessageHandler, isInteractiveReply } = await import('../messageHandler.js');

const message = { from: '919900000000', type: 'text', text: 'Hi' };

describe('MessageHandler rethrow mode', () => {
  it('rethrows failures before the FSM is entered, so the receipt stays retryable', async t => {
    t.mock.method(db.learners, 'findByWhatsAppId', async () => { throw new Error('db down'); });
    const handler = new MessageHandler();
    await assert.rejects(handler.handle(message, { rethrow: true }), /db down/);
    await handler.handle(message); // legacy callers still swallow
  });

  it('does not rethrow once the FSM has been entered (no replay of half-applied side effects)', async t => {
    t.mock.method(db.learners, 'findByWhatsAppId', async () => ({ id: 'learner-1' }));
    t.mock.method(db.messageLog, 'findMostRecentOutbound', async () => null);
    t.mock.method(db.messageLog, 'create', async () => ({}));
    const fsm = t.mock.method(conversationFSM, 'process', async () => { throw new Error('transient'); });
    await new MessageHandler().handle(message, { rethrow: true });
    assert.equal(fsm.mock.callCount(), 1);
  });
});

describe('isInteractiveReply', () => {
  it('treats button/list replies as interactive and free text/media as not', () => {
    assert.equal(isInteractiveReply({ type: 'interactive', buttonReplyId: 'next' }), true);
    assert.equal(isInteractiveReply({ type: 'interactive', listReplyId: 'row-1' }), true);
    assert.equal(isInteractiveReply({ type: 'button', buttonPayload: 'next' }), true);
    assert.equal(isInteractiveReply({ type: 'text' }), false);
    assert.equal(isInteractiveReply({ type: 'image' }), false);
  });
});
