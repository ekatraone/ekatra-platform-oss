/**
 * Proxy-chain handling for the deployed service.
 *
 * `trustProxyHops()` is the value for Express's `trust proxy`: how many proxies sit between the
 * internet and this process. It is configurable because the answer depends on the platform (on
 * Railway the public path crosses two proxies, so 1 made req.ip the edge, not the client, and every
 * per-IP rate limiter shared one bucket). `logProxyChainOnce()` logs, once per boot and only for a
 * request that came through the edge (it has X-Forwarded-For), enough to confirm the chain. All
 * addresses are truncated to the first two octets / hextets.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

/** TRUST_PROXY_HOPS as an integer ≥ 0; unset or invalid falls back to 2 in production, 1 elsewhere. */
export function trustProxyHops(env: Record<string, string | undefined> = process.env): number {
  const fallback = env.NODE_ENV === 'production' ? 2 : 1;
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw || !/^\d{1,2}$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

export function truncateIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (ip === '::1') return 'loopback';
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 2).join('.')}.x.x`;
  if (ip.includes(':')) return `${ip.split(':').filter(Boolean).slice(0, 2).join(':')}::x`;
  return 'unknown';
}

const sameAddress = (a: string, b: string) => a.replace(/^::ffff:/i, '') === b.replace(/^::ffff:/i, '');

export function describeProxyChain(
  req: Pick<Request, 'ip' | 'headers' | 'socket'>,
  trustHops?: number,
): string {
  const header = req.headers['x-forwarded-for'];
  const entries = (typeof header === 'string' ? header : '').split(',').map((e) => e.trim()).filter(Boolean);
  // Which forwarded entry Express picked as the client (req.ip), if any, counted from the left.
  const chosenIndex = req.ip ? entries.findIndex((e) => sameAddress(e, req.ip!)) : -1;
  const parts = [
    `req.ip=${truncateIp(req.ip)}`,
    `socket=${truncateIp(req.socket?.remoteAddress)}`,
    `xff_hops=${entries.length}`,
    `xff_first=${entries.length ? truncateIp(entries[0]) : 'none'}`,
    `xff_chosen=${chosenIndex >= 0 ? `${truncateIp(entries[chosenIndex])}@${chosenIndex + 1}/${entries.length}` : 'none'}`,
  ];
  if (trustHops !== undefined) parts.push(`trust_hops=${trustHops}`);
  return `proxy check: ${parts.join(' ')}`;
}

/** Logs once per process (so once per boot), for the first request that carries X-Forwarded-For. */
export function logProxyChainOnce(log: (msg: string) => void = (m) => logger.info(m), trustHops?: number) {
  let done = false;
  return (req: Request, _res: Response, next: NextFunction) => {
    // Platform health checks arrive without X-Forwarded-For and would tell us nothing about the real chain.
    if (!done && req.headers['x-forwarded-for']) {
      done = true;
      log(describeProxyChain(req, trustHops));
    }
    next();
  };
}
