/**
 * Alerts — fire-and-forget Slack / generic webhook notifications.
 *
 * Configure ALERT_WEBHOOK_URL (Slack incoming webhook or any POST endpoint).
 * If the env var is absent, alerts are logged locally only.
 */

import { logger } from './logger.js';

export type AlertLevel = 'warning' | 'critical';

export interface AlertPayload {
  level: AlertLevel;
  title: string;
  message: string;
  fields?: Record<string, string | number>;
}

/**
 * Send an alert. Non-blocking — failures are logged but never thrown.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;

  const prefix = payload.level === 'critical' ? '🚨' : '⚠️';
  const logLine = `${prefix} ALERT [${payload.level.toUpperCase()}] ${payload.title} — ${payload.message}`;

  if (payload.fields) {
    const fieldStr = Object.entries(payload.fields)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    logger.warn(`${logLine} | ${fieldStr}`);
  } else {
    logger.warn(logLine);
  }

  if (!url) return; // No webhook configured — local log is enough

  try {
    // Slack-compatible payload (works with any Incoming Webhook)
    const fieldBlocks = payload.fields
      ? Object.entries(payload.fields)
          .map(([k, v]) => `• *${k}*: ${v}`)
          .join('\n')
      : '';

    const body = JSON.stringify({
      text: `${prefix} *${payload.title}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${prefix} *[${payload.level.toUpperCase()}] ${payload.title}*\n${payload.message}${fieldBlocks ? `\n\n${fieldBlocks}` : ''}`,
          },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Ekatra | ${new Date().toISOString()} | ${process.env.RAILWAY_PUBLIC_DOMAIN || 'local'}` },
          ],
        },
      ],
    });

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error('Failed to send alert webhook (non-fatal):', err);
  }
}
