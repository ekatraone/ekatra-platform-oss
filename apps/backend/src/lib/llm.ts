/**
 * Provider-agnostic chat entrypoint for AI features.
 *
 * Prefers Anthropic/Claude (AZURE_ANTHROPIC_API_KEY); falls back to
 * Azure OpenAI (AZURE_OPENAI_*) when Claude is not configured, then to the
 * Meta Model API (MODEL_API_KEY). Pass `provider: 'meta'` to force the Meta (Muse) model.
 * All clients return an OpenAI-style completion, so callers read
 * `completion.choices[0].message.content` either way.
 */

import { anthropicClient } from './anthropicClient.js';
import { azureOpenAI } from './azureOpenAI.js';
import { metaModelClient, metaModelId } from './metaModelClient.js';

export interface LlmChatParams {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  model?: 'default' | 'mini';
  provider?: 'meta';
}

export function llmAvailable(): boolean {
  return anthropicClient.isAvailable() || azureOpenAI.isAvailable() || metaModelClient.isAvailable();
}

export interface LlmSource {
  provider: 'anthropic' | 'azure' | 'meta';
  model: string;
}

/**
 * Records which provider and model actually answered, on a non-enumerable property so the
 * completion still serializes as before. Read it back with `llmSource()`.
 */
function tag(completion: any, source: LlmSource): any {
  if (completion && typeof completion === 'object') {
    Object.defineProperty(completion, '__llmSource', { value: source, enumerable: false, configurable: true });
  }
  return completion;
}

export function llmSource(completion: any): LlmSource | undefined {
  return completion?.__llmSource;
}

const reportedModel = (completion: any, fallback: string) =>
  typeof completion?.model === 'string' && completion.model ? completion.model : fallback;

export async function llmChat(params: LlmChatParams): Promise<any> {
  if (params.provider === 'meta') {
    const c = await metaModelClient.createChatCompletion(params);
    return tag(c, { provider: 'meta', model: metaModelId() });
  }
  if (anthropicClient.isAvailable()) {
    const c = await anthropicClient.createChatCompletion(params);
    return tag(c, { provider: 'anthropic', model: reportedModel(c, process.env.AZURE_ANTHROPIC_MODEL || 'claude-sonnet-4-5') });
  }
  if (azureOpenAI.isAvailable()) {
    const c = await azureOpenAI.createChatCompletion(params);
    return tag(c, { provider: 'azure', model: reportedModel(c, process.env.AZURE_OPENAI_DEPLOYMENT || 'azure-openai') });
  }
  if (metaModelClient.isAvailable()) {
    const c = await metaModelClient.createChatCompletion(params);
    return tag(c, { provider: 'meta', model: metaModelId() });
  }
  throw new Error('No LLM configured — set AZURE_ANTHROPIC_API_KEY, AZURE_OPENAI_API_KEY or MODEL_API_KEY');
}
