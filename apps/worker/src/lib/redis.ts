/**
 * Redis client for the worker process.
 * Minimal — same pattern as apps/backend/src/lib/redis.ts
 */

import Redis from 'ioredis';

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  // BullMQ blocking consumers require unlimited per-request retries.
  client = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
  client.on('error', (err) => console.error('[worker] Redis error:', err));
  return client;
}
