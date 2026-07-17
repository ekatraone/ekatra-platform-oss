/**
 * Logger Utility
 * 
 * Structured logging with timestamps and levels.
 * PII (phone numbers, email addresses) is redacted before output.
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL as keyof typeof LOG_LEVELS] || LOG_LEVELS.info;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: keyof typeof LOG_LEVELS): boolean {
  return LOG_LEVELS[level] >= currentLevel;
}

// ── PII redaction ──────────────────────────────────────────────────────────

const PHONE_RE = /(?<!\w)(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?!\d)/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// Match WhatsApp IDs like whatsapp:+91XXXXXXXXXX
const WA_RE = /whatsapp:\+?\d{7,15}/g;

function redact(value: unknown): unknown {
  // Error's own properties (message, stack) are non-enumerable, so
  // JSON.stringify(error) below would otherwise always yield "{}"
  if (value instanceof Error) {
    return redact({ message: value.message, stack: value.stack, ...(value as any) });
  }
  if (typeof value === 'string') {
    return value
      .replace(WA_RE, 'whatsapp:[redacted]')
      .replace(PHONE_RE, '[phone-redacted]')
      .replace(EMAIL_RE, '[email-redacted]');
  }
  if (value && typeof value === 'object') {
    try {
      const str = JSON.stringify(value);
      const redacted = str
        .replace(WA_RE, 'whatsapp:[redacted]')
        .replace(PHONE_RE, '[phone-redacted]')
        .replace(EMAIL_RE, '[email-redacted]');
      return JSON.parse(redacted);
    } catch {
      return value;
    }
  }
  return value;
}

function redactArgs(message: string, args: any[]): [string, any[]] {
  return [redact(message) as string, args.map(redact)];
}

export const logger = {
  debug: (message: string, ...args: any[]) => {
    if (shouldLog('debug')) {
      const [m, a] = redactArgs(message, args);
      console.debug(`[${formatTimestamp()}] [DEBUG] ${m}`, ...a);
    }
  },
  
  info: (message: string, ...args: any[]) => {
    if (shouldLog('info')) {
      const [m, a] = redactArgs(message, args);
      console.info(`[${formatTimestamp()}] [INFO] ${m}`, ...a);
    }
  },
  
  warn: (message: string, ...args: any[]) => {
    if (shouldLog('warn')) {
      const [m, a] = redactArgs(message, args);
      console.warn(`[${formatTimestamp()}] [WARN] ${m}`, ...a);
    }
  },
  
  error: (message: string, ...args: any[]) => {
    if (shouldLog('error')) {
      const [m, a] = redactArgs(message, args);
      console.error(`[${formatTimestamp()}] [ERROR] ${m}`, ...a);
    }
  }
};
