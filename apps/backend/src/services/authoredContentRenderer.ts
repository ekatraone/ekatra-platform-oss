/**
 * Authored Content Renderer (Milestone 12b)
 *
 * Renders authored-course FSM nodes (screen / choice / quiz / day_end) straight
 * from fsm_json node data — these nodes have no lessons-table backing row, so they
 * never touch sendNextLesson()/runDayEndReview()'s read paths.
 *
 * All channel awareness for authored content lives HERE, not in conversationFSM:
 *  - Buttons: 1–3 options render as native buttons on both channels; >3 options
 *    render as a WhatsApp list message (Cloud API hard-caps interactive.button at 3)
 *    and as a full inline keyboard on Telegram (AC3a).
 *  - Media: Telegram gets a multipart buffer upload (works without a public URL);
 *    WhatsApp needs a publicly reachable URL — built from PUBLIC_BASE_URL. If that
 *    env is unset (local dev), the image is skipped with a log, text still goes out.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';

const getMessaging = () => import('@ekatra/messaging').then((m) => m.messaging);

export const AUTO_TRIGGER = '__auto__';

export interface AuthoredNode {
  id: string;
  type: 'screen' | 'choice' | 'quiz' | 'day_end' | 'end';
  day?: number;
  text?: string;
  fileUrl?: string;
  fileName?: string;
  mediaMissing?: boolean;
  link?: string;
  question?: string;
  options?: { id: string; label: string; correct?: boolean }[];
}

export interface AuthoredTransition {
  from: string;
  to: string;
  trigger: string;
  label?: string;
}

// public/ lives two levels up from src/services (same convention as index.ts's ../public from src/)
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

const normalize = (s: string) =>
  s.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim();

/** Non-auto outgoing edges become the node's buttons. */
export function buttonsForNode(node: AuthoredNode, outgoing: AuthoredTransition[]): { id: string; title: string }[] {
  if (node.type === 'quiz' && node.options?.length) {
    return node.options.map((o) => ({ id: o.id, title: o.label }));
  }
  if (node.type === 'day_end') {
    // day_end is always a wait point (pacing); its single outgoing edge is auto,
    // so synthesize a continue button.
    return [{ id: 'continue', title: 'Continue' }];
  }
  const seen = new Set<string>();
  const buttons: { id: string; title: string }[] = [];
  for (const t of outgoing) {
    if (t.trigger === AUTO_TRIGGER) continue;
    if (seen.has(t.trigger)) continue;
    seen.add(t.trigger);
    buttons.push({ id: t.trigger, title: t.label ?? t.trigger });
  }
  return buttons;
}

/** Matches learner input against a quiz node's options: by option id, label, or 1-based index. */
export function matchQuizOption(
  node: AuthoredNode,
  input: string
): { id: string; label: string; correct?: boolean } | undefined {
  const options = node.options ?? [];
  const n = normalize(input);
  if (!n) return undefined;
  const byId = options.find((o) => o.id === input || o.id === n);
  if (byId) return byId;
  const byLabel = options.find((o) => normalize(o.label) === n);
  if (byLabel) return byLabel;
  const idx = parseInt(n, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) return options[idx - 1];
  return undefined;
}

// Telegram and WhatsApp both reject image captions longer than 1024 characters.
export const CAPTION_LIMIT = 1024;

/** Sends the node's image. Returns false when nothing was delivered, so the caller can fall back to text. */
async function sendMedia(to: string, node: AuthoredNode, caption?: string): Promise<boolean> {
  if (!node.fileUrl) return false;
  const messaging = await getMessaging();

  try {
    if (to.startsWith('tg:')) {
      // Local file → buffer upload; no public URL needed (M11-proven path).
      const localPath = path.join(publicDir, node.fileUrl.replace(/^\/media\//, 'media/'));
      if (!existsSync(localPath)) {
        logger.warn(`Authored media file not on disk: ${localPath} (node ${node.id})`);
        return false;
      }
      const result = await messaging.sendImageBuffer(to, readFileSync(localPath), caption);
      if (!result.success) logger.warn(`Authored media send failed for ${node.id}: ${result.error}`);
      return !!result.success;
    }

    // WhatsApp Cloud API fetches media by URL — must be publicly reachable.
    const base = process.env.PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_URL;
    if (!base) {
      logger.warn(`PUBLIC_BASE_URL not set — skipping media for ${node.id} on WhatsApp`);
      return false;
    }
    const result = await messaging.sendImage(to, { imageUrl: `${base.replace(/\/$/, '')}${node.fileUrl}`, caption });
    if (!result.success) logger.warn(`Authored media send failed for ${node.id}: ${result.error}`);
    return !!result.success;
  } catch (err) {
    logger.warn(`Authored media send threw for ${node.id}: ${(err as Error)?.message}`);
    return false;
  }
}

async function sendWithButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<void> {
  const messaging = await getMessaging();
  if (buttons.length === 0) {
    if (body) await messaging.sendText(to, { text: body });
    return;
  }
  // WhatsApp interactive bodies are capped at 1024 chars and an over-long one is
  // rejected outright — send the text on its own, then the buttons.
  if (body.length > CAPTION_LIMIT) {
    await messaging.sendText(to, { text: body });
    body = 'Ready?';
  }
  if (buttons.length <= 3) {
    const result = await messaging.sendInteractiveButtons(to, {
      body: body || '…',
      buttons: buttons.map((b) => ({ id: b.id, title: b.title.substring(0, 20) })),
    });
    if (!result.success) logger.warn(`Authored buttons send failed: ${result.error}`);
    return;
  }
  // >3 options: WhatsApp list message / Telegram full inline keyboard (AC3a)
  const result = await messaging.sendInteractiveList(to, {
    body: body || '…',
    buttonText: 'Choose',
    sections: [{
      title: 'Options',
      rows: buttons.map((b) => ({ id: b.id, title: b.title.substring(0, 24) })),
    }],
  });
  if (!result.success) logger.warn(`Authored list send failed: ${result.error}`);
}

/**
 * Renders one authored node to a learner. `outgoing` determines the interaction:
 * auto-advance nodes render as plain content, wait-point nodes carry their buttons.
 */
export async function renderAuthoredNode(to: string, node: AuthoredNode, outgoing: AuthoredTransition[]): Promise<void> {
  const buttons = buttonsForNode(node, outgoing);

  if (node.type === 'quiz') {
    const body = node.question || 'Quick check:';
    await sendWithButtons(to, body, buttons);
    return;
  }

  if (node.type === 'day_end') {
    const body = `🎉 *Day ${node.day ?? ''} complete!* Great work — take a breather.`;
    await sendWithButtons(to, body, buttons);
    return;
  }

  // screen / choice
  let body = node.text ?? '';
  if (node.link) body = body ? `${body}\n\n🔗 ${node.link}` : `🔗 ${node.link}`;

  if (node.fileUrl) {
    // Media screen: image carries the text (and link) as caption; buttons (if any)
    // follow separately. A body too long for a caption goes out as its own text.
    const captionFits = body.length <= CAPTION_LIMIT;
    const sent = await sendMedia(to, node, captionFits ? body || undefined : undefined);
    if (!sent || !captionFits) {
      // Image skipped/failed or caption too long — the text must still reach the learner.
      await sendWithButtons(to, body || (buttons.length > 0 ? 'Ready?' : ''), buttons);
      return;
    }
    if (buttons.length > 0) await sendWithButtons(to, 'Ready?', buttons);
    return;
  }

  await sendWithButtons(to, body, buttons);
}

/** Gentle re-prompt when input doesn't match any of the node's expected replies. */
export async function repromptAuthoredNode(to: string, node: AuthoredNode, outgoing: AuthoredTransition[]): Promise<void> {
  const buttons = buttonsForNode(node, outgoing);
  const body = node.type === 'quiz'
    ? `Please pick one of the options:\n\n${node.question ?? ''}`
    : 'Please use one of the buttons to continue 👇';
  await sendWithButtons(to, body, buttons);
}
