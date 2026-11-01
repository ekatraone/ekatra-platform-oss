import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickReplyCacheKey } from '@ekatra/messaging';

const buttons = [
  { id: 'confirm_yes', title: 'Yes, start!' },
  { id: 'confirm_change', title: 'Change topic' },
];
const card = (topic: string, style: string) =>
  `✅ *Here's your learning plan:*\n\n📌 *Topic:* ${topic}\n🎯 *Goal:* beginner\n✍️ *Style:* ${style}`;

test('plan cards that differ after the first 40 characters get different cache keys', () => {
  const a = quickReplyCacheKey({ body: card('How to make slime', 'Professional'), buttons });
  const b = quickReplyCacheKey({ body: card('Farming Eggs', 'Professional'), buttons });
  const c = quickReplyCacheKey({ body: card('Farming Eggs', 'Casual & conversational'), buttons });
  assert.equal(new Set([a, b, c]).size, 3);
});

test('the same body and buttons give the same key, and button ids matter', () => {
  const body = card('Farming Eggs', 'Casual');
  assert.equal(quickReplyCacheKey({ body, buttons }), quickReplyCacheKey({ body, buttons: [...buttons] }));
  const otherIds = buttons.map((x) => ({ ...x, id: x.id + '_2' }));
  assert.notEqual(quickReplyCacheKey({ body, buttons }), quickReplyCacheKey({ body, buttons: otherIds }));
});
