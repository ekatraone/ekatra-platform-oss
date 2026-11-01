/** Firebase credential logging and the one-time proxy-chain log. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFirebaseAuth, setFirebaseAuthForTests } from '../firebaseAdmin.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { truncateIp, describeProxyChain, logProxyChainOnce, trustProxyHops } from '../proxyDiagnostics.js';
import { logger } from '../logger.js';

test('an unusable FIREBASE_SERVICE_ACCOUNT logs a fixed message and the error class, never the error text', () => {
  const secret = 'TOPSECRETKEYMATERIAL-9f8e7d';
  const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
  const logged: unknown[][] = [];
  const orig = (logger as any).error;
  (logger as any).error = (...args: unknown[]) => { logged.push(args); };
  try {
    setFirebaseAuthForTests(undefined);
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: secret, client_email: `x@${secret}.iam` });
    assert.equal(getFirebaseAuth(), null);
  } finally {
    (logger as any).error = orig;
    if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved;
    setFirebaseAuthForTests(undefined);
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'FIREBASE_SERVICE_ACCOUNT is set but could not be used');
  assert.match(String((logged[0][1] as any).errorClass), /^\w+$/);
  assert.ok(!JSON.stringify(logged).includes(secret), 'no part of the credential may reach the log');
  assert.deepEqual(Object.keys(logged[0][1] as object), ['errorClass']);
});

test('truncateIp keeps only the first two octets / hextets', () => {
  assert.equal(truncateIp('203.0.113.77'), '203.0.x.x');
  assert.equal(truncateIp('::ffff:198.51.100.9'), '198.51.x.x');
  assert.equal(truncateIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8::x');
  assert.equal(truncateIp('::1'), 'loopback');
  assert.equal(truncateIp(undefined), 'unknown');
  assert.equal(truncateIp('garbage'), 'unknown');
});

test('the proxy line shows truncated addresses, the leftmost and the chosen forwarded entry', () => {
  const line = describeProxyChain({
    ip: '106.213.45.9',
    headers: { 'x-forwarded-for': '106.213.45.9, 152.233.7.1' },
    socket: { remoteAddress: '100.64.0.9' },
  } as any, 2);
  assert.equal(line, 'proxy check: req.ip=106.213.x.x socket=100.64.x.x xff_hops=2 xff_first=106.213.x.x xff_chosen=106.213.x.x@1/2 trust_hops=2');
  assert.ok(!line.includes('45') && !line.includes('.9,') && !line.includes('7.1'), 'no full address');
});

test('when req.ip is the edge, the line shows the chosen entry is not the first (the symptom to look for)', () => {
  const line = describeProxyChain({
    ip: '152.233.7.1',
    headers: { 'x-forwarded-for': '106.213.45.9, 152.233.7.1' },
    socket: { remoteAddress: '100.64.0.9' },
  } as any, 1);
  assert.match(line, /req\.ip=152\.233\.x\.x .* xff_first=106\.213\.x\.x xff_chosen=152\.233\.x\.x@2\/2 trust_hops=1$/);
});

test('with no forwarded header the fields say none', () => {
  const line = describeProxyChain({ ip: '10.1.2.3', headers: {}, socket: {} } as any);
  assert.match(line, /xff_hops=0 xff_first=none xff_chosen=none$/);
});

// ── TRUST_PROXY_HOPS ───────────────────────────────────────────────────────

test('trust proxy hops default to 2 in production and 1 elsewhere, and parse as an integer', () => {
  assert.equal(trustProxyHops({ NODE_ENV: 'production' }), 2);
  assert.equal(trustProxyHops({}), 1);
  assert.equal(trustProxyHops({ NODE_ENV: 'development' }), 1);
  assert.equal(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '3' }), 3);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: '0' }), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: ' 2 ' }), 2);
  for (const junk of ['', 'two', '-1', '1.5', '2 hops', '999']) {
    assert.equal(trustProxyHops({ NODE_ENV: 'production', TRUST_PROXY_HOPS: junk }), 2, junk);
    assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: junk }), 1, junk);
  }
});

async function reqIpWith(hops: number, xff: string): Promise<{ ip: string; line: string | undefined }> {
  const app = express();
  app.set('trust proxy', hops);
  const lines: string[] = [];
  app.use(logProxyChainOnce((m) => lines.push(m), hops));
  app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
  const server = await new Promise<import('node:http').Server>((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ip`, { headers: { 'X-Forwarded-For': xff } });
    return { ip: ((await res.json()) as any).ip, line: lines[0] };
  } finally {
    server.close();
  }
}

test('with 2 hops and X-Forwarded-For "1.2.3.4, 152.233.0.1", req.ip is the real client 1.2.3.4', async () => {
  const { ip, line } = await reqIpWith(2, '1.2.3.4, 152.233.0.1');
  assert.equal(ip, '1.2.3.4');
  assert.equal(line, 'proxy check: req.ip=1.2.x.x socket=127.0.x.x xff_hops=2 xff_first=1.2.x.x xff_chosen=1.2.x.x@1/2 trust_hops=2');
});

test('with 1 hop (the old setting) the same request reports Railway\'s edge as the client', async () => {
  const { ip, line } = await reqIpWith(1, '1.2.3.4, 152.233.0.1');
  assert.equal(ip, '152.233.0.1');
  assert.match(line!, /xff_chosen=152\.233\.x\.x@2\/2 trust_hops=1$/);
});

test('with 0 hops X-Forwarded-For is ignored, and a spoofed header cannot choose the client', async () => {
  const { ip } = await reqIpWith(0, '9.9.9.9');
  assert.equal(ip, '127.0.0.1');
});

test('the proxy check logs exactly once, on the first request that carries X-Forwarded-For', () => {
  const lines: string[] = [];
  const mw = logProxyChainOnce((m) => lines.push(m));
  let nexts = 0;
  const next = () => { nexts++; };
  const internal: any = { ip: '100.64.0.7', headers: {}, socket: { remoteAddress: '100.64.0.7' } }; // platform health check
  const edge: any = { ip: '203.0.113.77', headers: { 'x-forwarded-for': '203.0.113.77' }, socket: { remoteAddress: '100.64.0.9' } };

  for (let i = 0; i < 3; i++) mw(internal, {} as any, next);
  assert.equal(lines.length, 0, 'requests without X-Forwarded-For are ignored');

  mw(edge, {} as any, next);
  mw(edge, {} as any, next);
  mw(internal, {} as any, next);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'proxy check: req.ip=203.0.x.x socket=100.64.x.x xff_hops=1 xff_first=203.0.x.x xff_chosen=203.0.x.x@1/1');
  assert.equal(nexts, 6, 'every request still continues down the chain');
});

test('the proxy check fires again after each boot (a new middleware instance logs once more)', () => {
  const lines: string[] = [];
  const edge: any = { ip: '203.0.113.77', headers: { 'x-forwarded-for': '203.0.113.77' }, socket: { remoteAddress: '100.64.0.9' } };
  for (let boot = 0; boot < 2; boot++) {
    const mw = logProxyChainOnce((m) => lines.push(m));
    mw(edge, {} as any, () => undefined);
    mw(edge, {} as any, () => undefined);
  }
  assert.equal(lines.length, 2);
});
