/**
 * Ekatra Backend Server
 * 
 * Leverages patterns from:
 * - TBS-Mindset-v2/server.js (cron, webhook handling)
 * - socrates-ek/Nodejs_backend/server.js (course delivery)
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Sentry from '@sentry/node';

// Get directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from monorepo root
// Try multiple paths: local .env first, then monorepo root
dotenv.config(); // Local .env in apps/backend
dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Monorepo root

// Sentry — initialise as early as possible, before any other imports that might throw.
// SENTRY_DSN env var must be set in production. If missing, Sentry is silently disabled.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
}

// ── Boot-time env validation ───────────────────────────────────────────────
// Fail hard and loudly rather than degrading silently into an insecure state.
(function validateEnv() {
  const required: Record<string, string | undefined> = {
    JWT_SECRET: process.env.JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    // REDIS_URL is optional — features degrade gracefully when absent
  };

  if (!process.env.REDIS_URL) {
    console.warn('[boot] REDIS_URL not set — distributed lock and dedup disabled (acceptable for single-instance deploys)');
  }

  // At least one messaging provider must be configured
  const hasTwilio = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER;
  const hasMeta = process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID;
  if (!hasTwilio && !hasMeta) {
    required['TWILIO_ACCOUNT_SID / META_ACCESS_TOKEN'] = undefined; // force failure below
  }

  // Webhook signature validation MUST be on in production
  if (process.env.NODE_ENV === 'production' && !process.env.META_APP_SECRET && !hasTwilio) {
    required['META_APP_SECRET'] = undefined;
  }

  const insecureDefaults: Record<string, string> = {
    JWT_SECRET: 'your-secret-key',
    DATABASE_URL: 'postgresql://ekatra:ekatra_password@localhost:5432/ekatra_db',
  };

  const errors: string[] = [];
  for (const [key, value] of Object.entries(required)) {
    if (!value) errors.push(`  ✗ ${key} is not set`);
    else if (insecureDefaults[key] === value) errors.push(`  ✗ ${key} is still using insecure default value — change it`);
  }

  if (errors.length > 0) {
    console.error('\nFATAL: Missing or insecure required environment variables:\n');
    errors.forEach((e) => console.error(e));
    console.error('\nSet these before starting the server. See .env.example for guidance.\n');
    process.exit(1);
  }
})();

// Initialize Azure OpenAI (will log initialization status)
import { azureOpenAI } from './lib/azureOpenAI.js';

// Routes
import { webhookRouter } from './routes/webhooks.js';
import { coursesRouter } from './routes/courses.js';
import { learnersRouter } from './routes/learners.js';
import { schedulesRouter } from './routes/schedules.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { certificatesRouter } from './routes/certificates.js';
import { analyticsRouter } from './routes/analytics.js';
import { adminRouter } from './routes/admin.js';
import { usersRouter } from './routes/users.js';
import { fsmRouter } from './routes/fsm.js';
import { authMiddleware } from './middleware/auth.js';

// Logger
import { logger } from './lib/logger.js';

const app: express.Application = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Rate limiter — 150 req/15 min per IP on all /api routes; webhooks skipped
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  skip: (req) => req.path.includes('/webhooks'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Please try again later.' },
});
app.use('/api', apiLimiter);

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { 
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Static admin panel — served at /admin/
// Resolved relative to compiled dist/ so the path works after tsc build
const publicDir = path.resolve(__dirname, '../public');
app.use('/admin', express.static(publicDir));
// Fallback: /admin with no trailing slash → redirect to /admin/
app.get('/admin', (_req, res) => res.redirect('/admin/admin.html'));

// Routes — public
app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/certificates', certificatesRouter);

// Routes — protected (require valid JWT)
app.use('/api', authMiddleware, analyticsRouter);
app.use('/api/admin', authMiddleware, adminRouter);
app.use('/api/courses', authMiddleware, coursesRouter);
app.use('/api/learners', authMiddleware, learnersRouter);
app.use('/api/schedules', authMiddleware, schedulesRouter);
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/fsm', authMiddleware, fsmRouter);

// Services initialization is deferred until database is available
let scheduler: any = null;

// Initialize services only if database is configured
async function initializeServices() {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== 'postgresql://ekatra:ekatra_password@localhost:5432/ekatra_db') {
    try {
      const { initializeDatabase, db } = await import('@ekatra/database');
      const { initializeMessaging, registerMessageSentCallback, preloadQuickReplyCache, registerCachePersistCallback } = await import('@ekatra/messaging');
      const { getScheduler } = await import('./services/scheduler.js');
      
      initializeDatabase({ connectionString: process.env.DATABASE_URL });

      // Choose messaging provider: Twilio > Cloud API (Meta)
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const webhookBase = process.env.WEBHOOK_BASE_URL ||
          (process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : undefined);
        const statusCallbackUrl = webhookBase
          ? `${webhookBase.replace(/\/+$/, '')}/api/webhooks/twilio`
          : undefined;
        initializeMessaging({
          provider: 'twilio',
          phoneNumberId: '',
          accessToken: '',
          twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
          twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
          twilioFromNumber: process.env.TWILIO_WHATSAPP_NUMBER,
          statusCallbackUrl,
        });
        logger.info(`✅ Messaging: Twilio WhatsApp (${process.env.TWILIO_WHATSAPP_NUMBER})${statusCallbackUrl ? ` | StatusCallback: ${statusCallbackUrl}` : ''}`);
      } else {
        initializeMessaging({
          provider: 'cloudapi',
          phoneNumberId: process.env.META_PHONE_NUMBER_ID!,
          accessToken: process.env.META_ACCESS_TOKEN!,
        });
        logger.info('✅ Messaging: Meta Cloud API');
      }

      // Secondary channel: Telegram (learners addressed as tg:<chat_id>)
      if (process.env.TELEGRAM_BOT_TOKEN) {
        const { initializeTelegram } = await import('@ekatra/messaging');
        initializeTelegram(process.env.TELEGRAM_BOT_TOKEN);
        logger.info('✅ Messaging: Telegram bot configured');
        if (process.env.TELEGRAM_POLLING === 'true') {
          const { startTelegramPolling } = await import('./services/telegramGateway.js');
          startTelegramPolling();
        }
      }

      // Hydrate Content API SID cache from DB — survives redeployments
      try {
        const cacheEntries = await db.contentApiCache.findAll();
        preloadQuickReplyCache(new Map(cacheEntries.map(e => [e.cache_key, e.content_sid])));
        logger.info(`✅ Content API cache: loaded ${cacheEntries.length} entr${cacheEntries.length === 1 ? 'y' : 'ies'}`);
      } catch (err) {
        logger.warn('⚠️ Content API cache table not yet migrated — skipping preload:', err);
      }
      registerCachePersistCallback((key, sid) => {
        db.contentApiCache.upsert(key, sid).catch(err => logger.error('Cache persist failed:', err));
      });

      // Register outbound message lifecycle tracking
      registerMessageSentCallback(async ({ to, type, content, result }) => {
        try {
          const learner = await db.learners.findByPhone(to);
          logger.info(`📤 ${type} → ${to}: ${content.substring(0, 80)} [${result.success ? result.messageId : `ERR: ${result.error}`}]`);
          await db.messageLog.create({
            learnerId: learner?.id,
            direction: 'outbound',
            messageType: type,
            // Content is not stored — course material already lives in the lessons table.
            // whatsappMessageId lets us correlate with delivery/read receipts.
            whatsappMessageId: result.messageId,
            status: result.success ? 'sent' : 'failed',
            metadata: result.success ? {} : { error: result.error },
          });
        } catch (err) {
          logger.error('Failed to log outbound message:', err);
        }
      });
      
      scheduler = getScheduler();
      
      logger.info('✅ Database and messaging services initialized');
    } catch (error) {
      logger.warn('⚠️ Services initialization failed (database may not be available):', error);
    }
  } else {
    logger.warn('⚠️ Database not configured, running in demo mode');
  }
}

// Cron fires enqueue jobs into BullMQ — the worker process does the actual work.
// This keeps the HTTP server unblocked and prevents duplicate sends when running
// multiple replicas (the worker acquires a distributed lock per job).
cron.schedule('0 9 * * *', async () => {
  const { getScheduledPushQueue } = await import('./lib/queues.js');
  const q = getScheduledPushQueue();
  if (q) {
    await q.add('daily-push', { scheduleId: 'all', scheduleName: 'Daily 9AM push' }, {
      jobId: `daily-push:${new Date().toISOString().slice(0, 10)}`, // one job per day
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    logger.info('⏰ Daily push job enqueued');
  } else if (scheduler) {
    // Fallback: no Redis — run inline (single-instance only)
    logger.warn('⚠️ Redis not available — running daily push inline (single-instance mode)');
    await scheduler.executeScheduledPushes();
  }
}, { scheduled: true, timezone: 'Asia/Kolkata' });

// Hourly schedule check
cron.schedule('0 * * * *', async () => {
  const { getScheduledPushQueue } = await import('./lib/queues.js');
  const q = getScheduledPushQueue();
  const hourKey = new Date().toISOString().slice(0, 13); // "2026-04-06T09"
  if (q) {
    await q.add('custom-schedule-check', { scheduleId: 'check', scheduleName: 'Hourly check' }, {
      jobId: `schedule-check:${hourKey}`,
      removeOnComplete: 24,
      removeOnFail: 10,
    });
    logger.info('⏰ Hourly schedule-check job enqueued');
  } else if (scheduler) {
    logger.warn('⚠️ Redis not available — running schedule check inline');
    await scheduler.checkCustomSchedules();
  }
}, { scheduled: true, timezone: 'Asia/Kolkata' });

// Flashcard review reminders — once daily at 9 AM IST
cron.schedule('0 9 * * *', async () => {
  const { getFlashcardReminderQueue } = await import('./lib/queues.js');
  const q = getFlashcardReminderQueue();
  const today = new Date().toISOString().slice(0, 10);
  if (q) {
    await q.add('flashcard-reminder', { date: today }, {
      jobId: `flashcard-reminder:${today}`,
      removeOnComplete: 30,
      removeOnFail: 10,
    });
    logger.info('⏰ Flashcard reminder job enqueued');
  } else if (scheduler) {
    logger.warn('⚠️ No Redis — flashcard reminders run inline');
    await scheduler.sendFlashcardReminders();
  }
}, { scheduled: true, timezone: 'Asia/Kolkata' });

// Error handling — Sentry captures unhandled errors before our JSON response
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// Start server
app.listen(PORT, async () => {
  logger.info('🚀 Ekatra Backend Started');
  logger.info(`📡 Server running on port ${PORT}`);
  logger.info(`⏰ Daily course delivery scheduled for 9:00 AM IST`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
  logger.info('='.repeat(50));
  
  // Initialize services after server starts
  await initializeServices();
});

export default app;
