import type { MessagingConfig } from '@ekatra/messaging';

type Environment = Record<string, string | undefined>;

/** Preserve legacy Twilio precedence unless the operator selects a provider. */
export function selectedProvider(env: Environment): 'twilio' | 'cloudapi' {
  const provider = env.WHATSAPP_PROVIDER ||
    (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? 'twilio' : 'cloudapi');
  if (provider !== 'twilio' && provider !== 'cloudapi') {
    throw new Error('WHATSAPP_PROVIDER must be cloudapi or twilio; other adapters are not enabled');
  }
  return provider;
}

export function messagingConfiguration(env: Environment): MessagingConfig {
  const provider = selectedProvider(env);
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for ${provider}`);
    return value;
  };
  if (provider === 'cloudapi') {
    return {
      provider,
      phoneNumberId: required('META_PHONE_NUMBER_ID'),
      accessToken: required('META_ACCESS_TOKEN'),
      appSecret: env.META_APP_SECRET,
    };
  }
  const base = env.WEBHOOK_BASE_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  return {
    provider, phoneNumberId: '', accessToken: '',
    twilioAccountSid: required('TWILIO_ACCOUNT_SID'),
    twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
    twilioFromNumber: required('TWILIO_WHATSAPP_NUMBER'),
    statusCallbackUrl: base ? `${base.replace(/\/+$/, '')}/api/webhooks/twilio` : undefined,
  };
}

/** Return names and configuration errors only; never include secret values. */
export function configurationErrors(env: Environment, service: 'api' | 'worker'): string[] {
  const errors: string[] = [];
  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required');
  if ((env.NODE_ENV === 'production' || service === 'worker') && !env.REDIS_URL) {
    errors.push('REDIS_URL is required');
  }
  if (service === 'api') {
    if (!env.JWT_SECRET || env.JWT_SECRET === 'your-secret-key') errors.push('JWT_SECRET must be configured securely');
    if (env.NODE_ENV === 'production' && (env.JWT_SECRET?.length || 0) < 32) errors.push('JWT_SECRET must contain at least 32 characters in production');
  }
  try {
    const config = messagingConfiguration(env);
    if (env.NODE_ENV === 'production' && service === 'api') {
      if (config.provider === 'cloudapi') {
        if (!env.META_APP_SECRET) errors.push('META_APP_SECRET is required');
        if (!env.META_WEBHOOK_VERIFY_TOKEN) errors.push('META_WEBHOOK_VERIFY_TOKEN is required');
      } else if (!env.WEBHOOK_BASE_URL && !env.RAILWAY_PUBLIC_DOMAIN) {
        errors.push('WEBHOOK_BASE_URL or RAILWAY_PUBLIC_DOMAIN is required for Twilio signature verification');
      }
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_POLLING !== 'true' && !env.TELEGRAM_WEBHOOK_SECRET) {
        errors.push('TELEGRAM_WEBHOOK_SECRET is required when Telegram webhooks are enabled');
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Invalid messaging configuration');
  }
  return errors;
}
