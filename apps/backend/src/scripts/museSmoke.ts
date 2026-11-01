/**
 * Muse smoke test — one llmChat({provider:'meta'}) call.
 *
 * Usage (MODEL_API_KEY, META_MODEL_API_BASE_URL, META_MODEL_ID exported in the shell):
 *   npx tsx src/scripts/museSmoke.ts
 */

import { llmChat } from '../lib/llm.js';

const started = Date.now();
const res = await llmChat({
  provider: 'meta',
  messages: [{ role: 'user', content: 'Reply with exactly: Muse online' }],
  maxTokens: 50,
});
const content = res?.choices?.[0]?.message?.content ?? '';
console.log(JSON.stringify({ ms: Date.now() - started, model: res?.model, content }));
if (!content.trim()) {
  console.error('Muse returned empty content');
  process.exit(1);
}
