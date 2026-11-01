/**
 * Shared model router for delivery and API callers.
 *
 * Text tiers:
 *   auto — Azure's `model-router` deployment picks the cheapest capable model
 *   best — AZURE_OPENAI_DEPLOYMENT (strong model, e.g. course generation)
 *   mini — AZURE_OPENAI_MINI_DEPLOYMENT (fixed small model)
 *
 * Media:
 *   image      — gpt-image-1 (fallback FLUX.2-pro), returns a PNG Buffer
 *   speech     — Azure Speech TTS (needs AZURE_SPEECH_KEY), returns MP3 Buffer
 *   transcribe — gpt-4o-mini-transcribe
 *   video      — not available until a video deployment (e.g. sora) exists
 *
 * Capabilities degrade gracefully: callers can check availability per task.
 */

import { logger } from './logger.js';

const API_VERSION = '2025-01-01-preview';
const IMAGE_API_VERSION = '2025-04-01-preview';

const endpoint = () => (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
const apiKey = () => process.env.AZURE_OPENAI_API_KEY || '';

export type TextTier = 'auto' | 'best' | 'mini';

const TEXT_DEPLOYMENTS: Record<TextTier, () => string> = {
  auto: () => process.env.AZURE_ROUTER_DEPLOYMENT || 'model-router',
  best: () => process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.6-sol',
  mini: () => process.env.AZURE_OPENAI_MINI_DEPLOYMENT || 'gpt-5-mini',
};

const IMAGE_DEPLOYMENT = () => process.env.AZURE_IMAGE_DEPLOYMENT || 'gpt-image-1';
const TRANSCRIBE_DEPLOYMENT = () => process.env.AZURE_TRANSCRIBE_DEPLOYMENT || 'gpt-4o-mini-transcribe';
const VIDEO_DEPLOYMENT = () => process.env.AZURE_VIDEO_DEPLOYMENT || ''; // none deployed yet

async function azureFetch(path: string, body: any, timeoutMs = 120_000): Promise<any> {
  const response = await fetch(`${endpoint()}${path}`, {
    method: 'POST',
    headers: { 'api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await response.json();
  if (data.error) throw new Error(`Azure ${path.split('/')[2]}: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

export const modelRouter = {
  isAvailable(): boolean {
    return Boolean(endpoint() && apiKey());
  },

  capabilities() {
    return {
      text: this.isAvailable(),
      image: this.isAvailable(),
      speech: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
      transcribe: this.isAvailable(),
      video: Boolean(VIDEO_DEPLOYMENT()),
    };
  },

  /**
   * Chat completion. Returns OpenAI-style completion; `completion.model`
   * reveals which model the router actually picked.
   */
  async chat(params: {
    messages: Array<{ role: string; content: string }>;
    tier?: TextTier;
    maxTokens?: number;
  }): Promise<any> {
    const deployment = TEXT_DEPLOYMENTS[params.tier || 'auto']();
    const data = await azureFetch(
      `/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`,
      { messages: params.messages, max_completion_tokens: params.maxTokens || 800 },
    );
    logger.info(`🧭 modelRouter chat tier=${params.tier || 'auto'} → ${data.model}`);
    return data;
  },

  /** Generate an illustration. Returns a PNG buffer. */
  async generateImage(prompt: string, opts?: { size?: string; quality?: 'low' | 'medium' | 'high' }): Promise<Buffer> {
    const data = await azureFetch(
      `/openai/deployments/${IMAGE_DEPLOYMENT()}/images/generations?api-version=${IMAGE_API_VERSION}`,
      { prompt, size: opts?.size || '1024x1024', quality: opts?.quality || 'low', n: 1 },
      180_000,
    );
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('Image generation returned no data');
    logger.info(`🖼️ modelRouter image generated (${Math.round(b64.length / 1024)}kb b64)`);
    return Buffer.from(b64, 'base64');
  },

  /** Text-to-speech narration via Azure Speech. Returns an MP3 buffer. */
  async generateSpeech(text: string, opts?: { voice?: string; language?: string }): Promise<Buffer> {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    if (!key || !region) throw new Error('Azure Speech not configured — set AZURE_SPEECH_KEY/REGION');

    const voice = opts?.voice || 'en-US-AvaMultilingualNeural';
    const lang = opts?.language || 'en-US';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>${escaped}</voice></speak>`,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Azure Speech TTS failed: HTTP ${response.status}`);
    logger.info('🔊 modelRouter speech generated');
    return Buffer.from(await response.arrayBuffer());
  },

  /** Speech-to-text for inbound voice notes. */
  async transcribe(audio: Buffer, filename = 'audio.ogg'): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', TRANSCRIBE_DEPLOYMENT());
    const response = await fetch(
      `${endpoint()}/openai/deployments/${TRANSCRIBE_DEPLOYMENT()}/audio/transcriptions?api-version=${API_VERSION}`,
      { method: 'POST', headers: { 'api-key': apiKey() }, body: form, signal: AbortSignal.timeout(120_000) },
    );
    const data: any = await response.json();
    if (data.error) throw new Error(`Transcription failed: ${data.error.message}`);
    return data.text || '';
  },

  /** Video generation — no deployment on this resource yet. */
  async generateVideo(_prompt: string): Promise<Buffer> {
    if (!VIDEO_DEPLOYMENT()) {
      throw new Error('No video deployment — add one (e.g. sora) in the Azure portal and set AZURE_VIDEO_DEPLOYMENT');
    }
    throw new Error('Video generation not yet implemented for this deployment');
  },
};
