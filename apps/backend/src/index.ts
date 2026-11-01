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
import { configurationErrors, messagingConfiguration } from '@ekatra/delivery/configuration';
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
const environmentErrors = configurationErrors(process.env, 'api');
if (environmentErrors.length > 0) {
  throw new Error(`Invalid API configuration: ${environmentErrors.join('; ')}`);
}

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
import { createDefaultSyncRouter } from './routes/sync.js';
import { createDefaultWhatsappAuthRouter } from './routes/authWhatsapp.js';
import { logProxyChainOnce, trustProxyHops } from './lib/proxyDiagnostics.js';
import { authMiddleware } from './middleware/auth.js';

// Logger
import { logger } from './lib/logger.js';

const app: express.Application = express();
const PORT = process.env.PORT || 3001;

// Middleware
// Behind the platform's proxies every request shares a proxy address; trust exactly as many hops
// as there are (TRUST_PROXY_HOPS; 2 in production, 1 elsewhere) so the per-IP rate limiters see the
// real client from X-Forwarded-For. Railway's public path crosses two proxies.
const TRUST_PROXY_HOPS = trustProxyHops();
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(logProxyChainOnce(undefined, TRUST_PROXY_HOPS)); // once per boot: confirms the chain (addresses truncated)
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
// Keep the raw bytes — Cloud API signature verification hashes the exact body.
const captureRawBody = (req: any, _res: unknown, buffer: Buffer) => { (req as express.Request).rawBody = Buffer.from(buffer); };
// Route-scoped parsers run first (body-parser skips an already-parsed body):
// provider webhooks carry long Indic messages / batched statuses well over 10kb,
// and FSM/course saves are validated against their own (64KB) limits in-route.
app.use('/api/webhooks',
  express.json({ limit: '1mb', verify: captureRawBody }),
  express.urlencoded({ extended: false, limit: '1mb' }));
app.use(['/api/fsm', '/api/courses', '/api/sync'], express.json({ limit: '256kb', verify: captureRawBody }));
app.use(express.json({
  limit: '10kb',
  verify: captureRawBody,
}));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Rate limiter — 150 req/15 min per IP on all /api routes; webhooks skipped
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  skip: (req) => req.path.includes('/webhooks') || req.path.startsWith('/sync/media/'),
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

// Re-hosted authored-course media (importAuthoredCourse.ts writes here).
// WhatsApp Cloud API fetches media by URL, so this must be publicly reachable in prod.
app.use('/media', express.static(path.join(publicDir, 'media'), { maxAge: '7d', immutable: true }));

// Routes — public
app.use('/health', healthRouter);
app.use('/api/auth/whatsapp', createDefaultWhatsappAuthRouter());
app.use('/api/auth', authRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/certificates', certificatesRouter);

// Routes — Maya offline app sync (learner JWT, verified in-router); must precede the catch-all /api mount below
app.use('/api/sync', createDefaultSyncRouter());

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

      initializeMessaging(messagingConfiguration(process.env));
      logger.info('Messaging provider initialized');

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

      if (messagingConfiguration(process.env).provider === 'cloudapi') {
        const { startWebhookRecovery } = await import('./services/webhookRecovery.js');
        startWebhookRecovery(Number(process.env.WEBHOOK_RECOVERY_INTERVAL_MS) || 15_000);
      }
      
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
//
// Course pushes: a half-hourly check runs every schedule whose send_time/days_of_week
// match in its own timezone, at most once per schedule per local day. Half-hourly so
// that :00 send times in both whole-hour zones (UTC) and half-hour zones (IST) fire
// on time. (There is no separate unconditional 9 AM "all schedules" push — it ignored
// send_time and days_of_week and double-sent schedules also matched by this check.)
cron.schedule('0,30 * * * *', async () => {
  const { getScheduledPushQueue } = await import('./lib/queues.js');
  const q = getScheduledPushQueue();
  const firedAt = new Date();
  const slotKey = firedAt.toISOString().slice(0, 16); // "2026-04-06T09:30"
  if (q) {
    // The worker matches schedules at the job's enqueue time (job.timestamp).
    await q.add('custom-schedule-check', { scheduleId: 'check', scheduleName: 'Schedule check' }, {
      jobId: `schedule-check:${slotKey}`,
      removeOnComplete: 48,
      removeOnFail: 10,
    });
    logger.info('⏰ Schedule-check job enqueued');
  } else if (scheduler) {
    logger.warn('⚠️ Redis not available — running schedule check inline');
    await scheduler.checkCustomSchedules(firedAt);
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
  // Client errors (body-parser 413 too large / 400 malformed JSON, etc.) are
  // not server faults — return their status instead of a 500.
  const status = (err as any).status ?? (err as any).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const type = (err as any).type;
    logger.warn(`Client error ${status} on ${req.method} ${req.path}: ${type || err.message}`);
    res.status(status).json({
      success: false,
      error: type === 'entity.too.large' ? 'Payload too large'
        : type === 'entity.parse.failed' ? 'Malformed JSON'
        : (err as any).expose ? err.message : 'Bad request',
    });
    return;
  }
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
  logger.info(`⏰ Course delivery: half-hourly schedule check (per-schedule send_time/timezone)`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
  logger.info('='.repeat(50));
  
  // Initialize services after server starts
  await initializeServices();
});

export default app;
