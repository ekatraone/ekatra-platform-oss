type Probe = () => Promise<void>;

/** Core readiness must not depend on optional AI or unused provider accounts. */
export async function checkReadiness(probes: Record<string, Probe>, timeoutMs = 2000) {
  const entries = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(probe),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Probe timed out')), timeoutMs);
        }),
      ]);
      return [name, { status: 'healthy', latency: Date.now() - started }] as const;
    } catch {
      // Connection errors can contain credentials or internal addresses.
      return [name, { status: 'unavailable', latency: Date.now() - started }] as const;
    } finally {
      clearTimeout(timer);
    }
  }));
  return { ready: entries.every(([, check]) => check.status === 'healthy'), checks: Object.fromEntries(entries) };
}
