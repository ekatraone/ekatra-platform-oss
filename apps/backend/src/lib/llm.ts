/**
 * Provider-agnostic chat entrypoint for AI features.
 *
 * Prefers Anthropic/Claude (AZURE_ANTHROPIC_API_KEY); falls back to
 * Azure OpenAI (AZURE_OPENAI_*) when Claude is not configured. Both
 * clients return an OpenAI-style completion, so callers read
 * `completion.choices[0].message.content` either way.
 */

import { anthropicClient } from './anthropicClient.js';
import { azureOpenAI } from './azureOpenAI.js';

export interface LlmChatParams {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  model?: 'default' | 'mini';
}

export function llmAvailable(): boolean {
  return anthropicClient.isAvailable() || azureOpenAI.isAvailable();
}

export async function llmChat(params: LlmChatParams): Promise<any> {
  if (anthropicClient.isAvailable()) {
    return anthropicClient.createChatCompletion(params);
  }
  if (azureOpenAI.isAvailable()) {
    return azureOpenAI.createChatCompletion(params);
  }
  throw new Error('No LLM configured — set AZURE_ANTHROPIC_API_KEY or AZURE_OPENAI_API_KEY');
}
