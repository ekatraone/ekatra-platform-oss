/**
 * Meta Model API client (Muse).
 *
 * OpenAI-compatible Chat Completions at META_MODEL_API_BASE_URL. Server-side only.
 * Muse models always reason, so reasoning tokens count against max_completion_tokens;
 * the budget below is padded to leave room for visible output.
 */

import { logger } from './logger.js';

const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
const DEFAULT_MODEL = 'muse-wonder-1.0';
const DEFAULT_IMAGE_MODEL = 'muse-image-1.0';
const REASONING_HEADROOM = 4000;
const MAX_COMPLETION_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 240_000;
const IMAGE_TIMEOUT_MS = 90_000;

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Only JPEG (FF D8 FF) up to 2 MB is stored or served; anything else counts as an image failure. */
export function assertStorableJpeg(image: Buffer): Buffer {
  if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    throw new Error('Meta image API returned a non-JPEG image');
  }
  if (image.length > MAX_IMAGE_BYTES) throw new Error(`Meta image is too large (${image.length} bytes)`);
  return image;
}

/** The model actually used for chat completions (META_MODEL_ID, else the default). */
export function metaModelId(): string {
  return process.env.META_MODEL_ID || DEFAULT_MODEL;
}

class MetaModelClient {
  isAvailable(): boolean {
    return !!process.env.MODEL_API_KEY;
  }

  async createChatCompletion(params: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new Error('Meta Model API not configured — set MODEL_API_KEY');

    const baseUrl = (process.env.META_MODEL_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = metaModelId();
    const budget = Math.min((params.maxTokens || 500) + REASONING_HEADROOM, MAX_COMPLETION_TOKENS);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: params.messages,
        max_completion_tokens: budget,
        reasoning_effort: 'low',
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      logger.error('Meta Model API error', { status: res.status, detail });
      throw new Error(`Meta Model API ${res.status}`);
    }
    return res.json();
  }

  /**
   * Generate one 1024×1024 JPEG (WhatsApp accepts only JPEG/PNG). Returns the raw bytes.
   * Throws on HTTP errors, timeouts and empty responses; callers treat images as best-effort.
   */
  async createImage(prompt: string): Promise<Buffer> {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new Error('Meta Model API not configured — set MODEL_API_KEY');

    const baseUrl = (process.env.META_MODEL_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.META_IMAGE_MODEL_ID || DEFAULT_IMAGE_MODEL,
        prompt,
        n: 1,
        size: '1024x1024',
        output_format: 'jpeg',
      }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      logger.error('Meta image API error', { status: res.status, detail });
      throw new Error(`Meta image API ${res.status}`);
    }
    const body: any = await res.json();
    const b64 = body?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) throw new Error('Meta image API returned no image');
    return assertStorableJpeg(Buffer.from(b64, 'base64'));
  }
}

export const metaModelClient = new MetaModelClient();
