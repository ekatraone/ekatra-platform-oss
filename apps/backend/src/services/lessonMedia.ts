/**
 * Lesson Media Service
 *
 * Enriches a lesson with AI-generated media via the model router and sends
 * it to a learner: illustration image (gpt-image-1), voice narration
 * (Azure Speech, when configured), video (when a video deployment exists).
 * Buffer sends are Telegram-only today; WhatsApp keeps text delivery.
 */

import { logger } from '../lib/logger.js';
import { modelRouter } from '../lib/modelRouter.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);
const getMessaging = () => import('@ekatra/messaging').then((m) => m.messaging);

export interface LessonMediaResult {
  sent: string[];
  skipped: Array<{ type: string; reason: string }>;
}

export async function sendLessonWithMedia(lessonId: string, to: string): Promise<LessonMediaResult> {
  const db = await getDb();
  const messaging = await getMessaging();

  const lesson = await db.lessons.findById(lessonId);
  if (!lesson) throw new Error(`Lesson ${lessonId} not found`);

  const caps = modelRouter.capabilities();
  const sent: string[] = [];
  const skipped: Array<{ type: string; reason: string }> = [];
  const lessonText = `${lesson.title}\n\n${lesson.content || ''}`.slice(0, 3000);

  // One cheap routed call plans both the illustration and the narration script
  const plan = await modelRouter.chat({
    tier: 'auto',
    // Reasoning models spend max_completion_tokens on hidden reasoning first —
    // too small a budget returns empty content
    maxTokens: 2500,
    messages: [
      {
        role: 'system',
        content:
          'You prepare micro-learning media. Reply with ONLY valid JSON: ' +
          '{"imagePrompt": "<flat illustration prompt for this lesson, warm colors, no text in image>", ' +
          '"narration": "<the lesson rewritten as a friendly 3-4 sentence spoken narration>"}',
      },
      { role: 'user', content: lessonText },
    ],
  });
  const raw = (plan.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const media = JSON.parse(raw) as { imagePrompt: string; narration: string };

  // Text first — always works on every channel
  const textResult = await messaging.sendText(to, { text: `📚 *${lesson.title}*\n\n${lesson.content || ''}` });
  if (textResult.success) sent.push('text');
  else skipped.push({ type: 'text', reason: textResult.error || 'send failed' });

  if (caps.image) {
    try {
      const image = await modelRouter.generateImage(media.imagePrompt);
      const result = await messaging.sendImageBuffer(to, image, lesson.title);
      if (result.success) sent.push('image');
      else skipped.push({ type: 'image', reason: result.error || 'send failed' });
    } catch (err: any) {
      skipped.push({ type: 'image', reason: err.message });
    }
  } else skipped.push({ type: 'image', reason: 'no image capability' });

  if (caps.speech) {
    try {
      const audio = await modelRouter.generateSpeech(media.narration);
      const result = await messaging.sendVoiceBuffer(to, audio);
      if (result.success) sent.push('audio');
      else skipped.push({ type: 'audio', reason: result.error || 'send failed' });
    } catch (err: any) {
      skipped.push({ type: 'audio', reason: err.message });
    }
  } else skipped.push({ type: 'audio', reason: 'Azure Speech not configured (AZURE_SPEECH_KEY)' });

  if (caps.video) {
    try {
      const video = await modelRouter.generateVideo(media.imagePrompt);
      const result = await messaging.sendVideoBuffer(to, video, lesson.title);
      if (result.success) sent.push('video');
      else skipped.push({ type: 'video', reason: result.error || 'send failed' });
    } catch (err: any) {
      skipped.push({ type: 'video', reason: err.message });
    }
  } else skipped.push({ type: 'video', reason: 'no video deployment on the Azure resource' });

  logger.info(`🎬 Lesson media → ${to}: sent [${sent.join(', ')}]`);
  return { sent, skipped };
}
