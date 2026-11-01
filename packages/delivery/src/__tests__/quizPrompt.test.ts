import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuizPrompt } from '../services/courseDelivery.js';

const question = { question: 'Pick one', options: ['one', 'two', 'three', 'four'] };

test('all four options are listed in the body, so a D answer is reachable', () => {
  const prompt = buildQuizPrompt(question, { telegram: false });
  assert.match(prompt.body, /A\) one\nB\) two\nC\) three\nD\) four/);
  // WhatsApp: 3-button cap, D is answered by typing the letter
  assert.deepEqual(prompt.buttons.map(b => b.id), ['A', 'B', 'C']);
  assert.match(prompt.body, /reply \*D\*/);
});

test('Telegram shows a button per option', () => {
  const prompt = buildQuizPrompt(question, { telegram: true });
  assert.deepEqual(prompt.buttons, ['A', 'B', 'C', 'D'].map(l => ({ id: l, title: l })));
  assert.doesNotMatch(prompt.body, /reply/);
});

test('three-option questions are unchanged apart from listing', () => {
  const prompt = buildQuizPrompt({ question: 'Q', options: ['x', 'y', 'z'] }, { telegram: false });
  assert.equal(prompt.body, 'Q\n\nA) x\nB) y\nC) z');
  assert.equal(prompt.buttons.length, 3);
});
