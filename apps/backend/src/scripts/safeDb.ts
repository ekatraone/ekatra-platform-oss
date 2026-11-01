/**
 * Guard for hackathon scripts: refuse to run against production.
 * Allowed: localhost, or a Railway demo database when ALLOW_DEMO_DB=1.
 * Never allowed: anything containing neon.tech.
 */

export function assertSafeDatabase(url: string | undefined = process.env.DATABASE_URL): void {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (/neon\.tech/i.test(url)) throw new Error('Refusing to run: DATABASE_URL points at neon.tech (production)');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Refusing to run: DATABASE_URL is not a valid URL');
  }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return;
  if (process.env.ALLOW_DEMO_DB === '1' && /(\.rlwy\.net|\.railway\.internal)$/i.test(host)) return;
  throw new Error(`Refusing to run: DATABASE_URL host "${host}" is not localhost or an allowed demo database`);
}
