/**
 * Authored media screens must never lose their text or link when the image
 * can't be sent or the text is too long for a caption. Messaging is mocked.
 */

import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { messaging } from '@ekatra/messaging';
import { renderAuthoredNode, CAPTION_LIMIT, AuthoredNode } from '../authoredContentRenderer.js';

const savedBase = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, BACKEND_PUBLIC_URL: process.env.BACKEND_PUBLIC_URL };

afterEach(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(savedBase)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function capture(imageResult = { success: true } as any) {
  const sent: { kind: string; body?: string; caption?: string }[] = [];
  mock.method(messaging, 'sendText', async (_to: string, m: any) => { sent.push({ kind: 'text', body: m.text }); return { success: true }; });
  mock.method(messaging, 'sendInteractiveButtons', async (_to: string, m: any) => { sent.push({ kind: 'buttons', body: m.body }); return { success: true }; });
  mock.method(messaging, 'sendImage', async (_to: string, m: any) => { sent.push({ kind: 'image', caption: m.caption }); return imageResult; });
  mock.method(messaging, 'sendImageBuffer', async (_to: string, _b: any, caption?: string) => { sent.push({ kind: 'image', caption }); return imageResult; });
  return sent;
}

const node = (over: Partial<AuthoredNode> = {}): AuthoredNode => ({
  id: 'screen_1',
  type: 'screen',
  text: 'Empathy maps help you see the user.',
  link: 'https://example.org/empathy',
  fileUrl: '/media/dt/empathy.png',
  ...over,
});

test('WhatsApp without PUBLIC_BASE_URL still sends the text and link', async () => {
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.BACKEND_PUBLIC_URL;
  const sent = capture();
  await renderAuthoredNode('+911234567890', node(), []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'text');
  assert.match(sent[0].body!, /Empathy maps/);
  assert.match(sent[0].body!, /example\.org\/empathy/);
});

test('Telegram with the file missing on disk falls back to text with buttons', async () => {
  const sent = capture();
  await renderAuthoredNode('tg:1', node({ fileUrl: '/media/does-not-exist-xyz.png' }), [
    { from: 'screen_1', to: 'screen_2', trigger: 'next', label: 'Next' },
  ]);
  assert.deepEqual(sent.map((s) => s.kind), ['buttons']);
  assert.match(sent[0].body!, /Empathy maps/);
});

test('a failed image send falls back to text', async () => {
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  const sent = capture({ success: false, error: 'boom' });
  await renderAuthoredNode('+911234567890', node(), []);
  assert.deepEqual(sent.map((s) => s.kind), ['image', 'text']);
  assert.match(sent[1].body!, /Empathy maps/);
});

test('a short body rides as the caption, including the link', async () => {
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  const sent = capture();
  await renderAuthoredNode('+911234567890', node(), []);
  assert.equal(sent.length, 1);
  assert.match(sent[0].caption!, /Empathy maps[\s\S]*example\.org\/empathy/);
});

test('a body longer than the caption limit goes out as its own text', async () => {
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  const sent = capture();
  const long = 'x'.repeat(CAPTION_LIMIT + 50);
  await renderAuthoredNode('+911234567890', node({ text: long }), []);
  assert.deepEqual(sent.map((s) => s.kind), ['image', 'text']);
  assert.equal(sent[0].caption, undefined);
  assert.ok(sent[1].body!.startsWith(long));
});

test('WhatsApp: a long body with buttons goes out as text, then the buttons', async () => {
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  const sent = capture();
  const long = 'x'.repeat(CAPTION_LIMIT + 50);
  const next = [{ from: 'screen_1', to: 'screen_2', trigger: 'next', label: 'Next' }];
  await renderAuthoredNode('+911234567890', node({ text: long }), next);
  assert.deepEqual(sent.map((s) => s.kind), ['image', 'text', 'buttons']);
  assert.ok(sent[1].body!.startsWith(long));
  assert.ok(sent[2].body!.length <= CAPTION_LIMIT);

  // Same for a plain (no image) screen.
  const plain = capture();
  await renderAuthoredNode('+911234567890', node({ text: long, fileUrl: undefined }), next);
  assert.deepEqual(plain.map((s) => s.kind), ['text', 'buttons']);
  assert.ok(plain[0].body!.startsWith(long));
});
