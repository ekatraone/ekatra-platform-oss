/**
 * Anthropic/Claude Client
 *
 * Wraps the Anthropic SDK pointed at Azure AI Foundry's Claude endpoint.
 * Returns OpenAI-compatible `{ choices: [{ message: { content } }] }` shape
 * so existing callers (courseGenerator, qaService) need minimal changes.
 *
 * Endpoint: https://<your-resource>.services.ai.azure.com/anthropic
 * Auth:     x-api-key header (AZURE_ANTHROPIC_API_KEY)
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

class AnthropicClientService {
  private client: Anthropic | null = null;
  private modelDefault = 'claude-sonnet-4-5';
  private modelMini = 'claude-sonnet-4-5'; // use same until Haiku is available on this endpoint

  initialize(): void {
    const apiKey = process.env.AZURE_ANTHROPIC_API_KEY;
    const baseURL = process.env.AZURE_ANTHROPIC_ENDPOINT; // e.g. https://…/anthropic

    if (!apiKey) {
      logger.warn('Anthropic/Claude not configured — AZURE_ANTHROPIC_API_KEY missing');
      return;
    }

    try {
      this.client = new Anthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: { 'anthropic-version': '2023-06-01' },
      });

      this.modelDefault = process.env.AZURE_ANTHROPIC_MODEL || 'claude-sonnet-4-5';
      this.modelMini = process.env.AZURE_ANTHROPIC_MODEL_MINI || this.modelDefault;

      logger.info('✅ Anthropic/Claude client initialized', {
        endpoint: (baseURL || 'api.anthropic.com').substring(0, 60),
        model: this.modelDefault,
        modelMini: this.modelMini,
      });
    } catch (error) {
      logger.error('Failed to initialize Anthropic client:', error);
      this.client = null;
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Chat completion — returns OpenAI-shaped response so callers need no changes.
   * Pass `model: 'mini'` for cheaper/faster tasks (Q&A); omit for generation.
   */
  async createChatCompletion(params: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    model?: 'default' | 'mini';
  }): Promise<{ choices: Array<{ message: { content: string | null } }> }> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized — check AZURE_ANTHROPIC_API_KEY');
    }

    const modelName = params.model === 'mini' ? this.modelMini : this.modelDefault;

    // Anthropic requires system messages to be separated from the conversation
    const systemParts = params.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const conversationMessages = params.messages.filter((m) => m.role !== 'system');

    const response = await this.client.messages.create({
      model: modelName,
      max_tokens: params.maxTokens || 500,
      temperature: params.temperature ?? 0.7,
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      messages: conversationMessages as Anthropic.MessageParam[],
    });

    const content =
      response.content[0]?.type === 'text' ? response.content[0].text : null;

    return { choices: [{ message: { content } }] };
  }
}

export const anthropicClient = new AnthropicClientService();
anthropicClient.initialize();
