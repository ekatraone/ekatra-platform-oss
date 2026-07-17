/**
 * Shared Redis client
 *
 * Single IORedis instance reused across the backend.
 * Falls back gracefully when REDIS_URL is not configured (dev/test mode).
 */

import Redis from 'ioredis';
import { logger } from './logger.js';

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('⚠️ REDIS_URL not set — Redis features (idempotency, distributed lock) are disabled');
    return null;
  }

  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on('error', (err) => logger.error('Redis error:', err));
  client.on('connect', () => logger.info('✅ Redis connected'));

  return client;
}

/**
 * Acquire a distributed lock. Returns true if this process acquired the lock,
 * false if another process already holds it.
 *
 * @param key  Lock name (e.g. "lock:daily-reminder:2026-04-06")
 * @param ttlSeconds  Lock TTL — auto-expires so a crashed holder doesn't block forever
 */
export async function acquireLock(key: string, ttlSeconds = 300): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // No Redis — allow (single-instance safe degradation)

  const result = await redis.set(`lock:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Release a lock early (e.g. after job completes successfully).
 */
export async function releaseLock(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`lock:${key}`);
}

/**
 * time we've seen this ID (i.e. caller should process it). Returns false if
 * it was already seen — caller should skip.
 *
 * TTL of 24 h is enough to cover WhatsApp's retry window.
 */
export async function markWebhookSeen(messageId: string, ttlSeconds = 86400): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // No Redis — process anyway (safe degradation)

  // SET key 1 NX EX ttl — returns "OK" if set (first time), null if already existed
  const result = await redis.set(`whook:${messageId}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Per-learner message processing lock.
 *
 * Serialises concurrent inbound messages from the same learner so the FSM
 * never races. The lock expires automatically after `ttlSeconds` even if the
 * holder crashes, preventing a permanent block.
 *
 * Returns a release function (call when processing is done) or null if
 * another message from this learner is currently being processed (caller
 * should requeue / discard).
 */
export async function acquireLearnerLock(
  learnerId: string,
  ttlSeconds = 30,
): Promise<(() => Promise<void>) | null> {
  const redis = getRedis();
  if (!redis) {
    // No Redis — allow and return a no-op release
    return async () => {};
  }

  const key = `learner-lock:${learnerId}`;
  const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  if (result !== 'OK') return null;

  return async () => {
    await redis.del(key);
  };
}
