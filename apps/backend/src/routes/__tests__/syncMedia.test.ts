/** GET /api/sync/media/:id — public, validated, long-cached. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createSyncRouter } from '../sync.js';

const ID = '00000000-0000-4000-8000-0000000000f1';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

let server: Server;
let base = '';

before(async () => {
  const db = {
    async raw(sql: string, p: any[] = []) {
      if (sql.includes('FROM lesson_media') && p[0] === ID) return { rows: [{ mime: 'image/jpeg', bytes: JPEG }] };
      return { rows: [] };
    },
  };
  const app = express();
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: 'x' }) } }));
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('media: serves the JPEG with no auth and immutable public caching', async () => {
  const res = await fetch(`${base}/api/sync/media/${ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
});

test('media: a non-UUID id or an unknown id is a 404', async () => {
  assert.equal((await fetch(`${base}/api/sync/media/not-a-uuid`)).status, 404);
  assert.equal((await fetch(`${base}/api/sync/media/1%27%20OR%201=1`)).status, 404);
  assert.equal((await fetch(`${base}/api/sync/media/00000000-0000-4000-8000-0000000000f2`)).status, 404);
});

test('media: sends an ETag and answers If-None-Match with 304 and no body', async () => {
  const first = await fetch(`${base}/api/sync/media/${ID}`);
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${ID}"`);
  const second = await fetch(`${base}/api/sync/media/${ID}`, { headers: { 'If-None-Match': etag! } });
  assert.equal(second.status, 304);
  assert.equal((await second.arrayBuffer()).byteLength, 0);
  assert.equal(second.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const stale = await fetch(`${base}/api/sync/media/${ID}`, { headers: { 'If-None-Match': '"other"' } });
  assert.equal(stale.status, 200);
});

test('media: has its own per-IP limit of 120 requests per minute', async () => {
  let limited = 0;
  for (let i = 0; i < 130; i++) {
    const res = await fetch(`${base}/api/sync/media/${ID}`, { headers: { 'If-None-Match': `"${ID}"` } });
    if (res.status === 429) limited++;
  }
  assert.ok(limited >= 1, 'expected a 429 once the per-minute limit is exceeded');
});

test('media limiter keys on the real client behind a trusted proxy (X-Forwarded-For)', async () => {
  const db = { async raw() { return { rows: [{ mime: 'image/jpeg', bytes: JPEG }] }; } };
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/sync', createSyncRouter({ db, generator: { generate: async () => ({ id: 'x' }) } }));
  const proxied = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(proxied.address() as AddressInfo).port}/api/sync/media/${ID}`;
  try {
    // One noisy client exhausts its own budget...
    let noisyBlocked = false;
    for (let i = 0; i < 125; i++) {
      const res = await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      if (res.status === 429) noisyBlocked = true;
    }
    assert.equal(noisyBlocked, true);
    // ...but a different client behind the same proxy is unaffected (e.g. Twilio's fetch).
    assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status, 200);
  } finally {
    proxied.close();
  }
});

test('index.ts sets trust proxy from TRUST_PROXY_HOPS so per-IP limiters see real clients', () => {
  const source = readFileSync(fileURLToPath(new URL('../../index.ts', import.meta.url)), 'utf-8');
  assert.match(source, /app\.set\('trust proxy', TRUST_PROXY_HOPS\);/);
  assert.match(source, /const TRUST_PROXY_HOPS = trustProxyHops\(\);/);
});

test('media: the rest of the sync API still requires auth', async () => {
  assert.equal((await fetch(`${base}/api/sync/me`)).status, 401);
});
