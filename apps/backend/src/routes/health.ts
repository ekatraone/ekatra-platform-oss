/**
 * Health & System API Routes
 * 
 * Health checks, metrics, and system status
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

export const healthRouter: Router = Router();

const startTime = new Date();

/**
 * GET /health
 * Basic health check for load balancers
 */
healthRouter.get('/', async (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime.getTime()) / 1000)
  });
});

/**
 * GET /health/ready
 * Readiness probe - checks all dependencies
 */
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};

  // Check database (lazy import)
  try {
    const { db } = await import('@ekatra/database');
    const start = Date.now();
    await db.raw('SELECT 1');
    checks.database = { status: 'healthy', latency: Date.now() - start };
  } catch (error: any) {
    checks.database = { status: 'unavailable', error: error.message };
  }

  // Redis check removed - not used in current setup

  // Check Twilio (if configured)
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const start = Date.now();
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(5000),
      });
      checks.twilio = {
        status: res.ok ? 'healthy' : 'unavailable',
        latency: Date.now() - start,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (error: any) {
      checks.twilio = { status: 'unavailable', error: error.message };
    }
  } else {
    checks.twilio = { status: 'unavailable', error: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' };
  }

  // Check Azure AI Foundry (if configured)
  if (process.env.AZURE_ANTHROPIC_ENDPOINT && process.env.AZURE_ANTHROPIC_API_KEY) {
    try {
      const start = Date.now();
      const endpoint = process.env.AZURE_ANTHROPIC_ENDPOINT.replace(/\/$/, '');
      const res = await fetch(`${endpoint}/`, {
        headers: { 'api-key': process.env.AZURE_ANTHROPIC_API_KEY },
        signal: AbortSignal.timeout(5000),
      });
      // Any response (even 404) means the endpoint is reachable
      checks.azure_ai = {
        status: res.status < 500 ? 'healthy' : 'unavailable',
        latency: Date.now() - start,
        ...(res.status >= 500 ? { error: `HTTP ${res.status}` } : {}),
      };
    } catch (error: any) {
      checks.azure_ai = { status: 'unavailable', error: error.message };
    }
  } else {
    checks.azure_ai = { status: 'unavailable', error: 'AZURE_ANTHROPIC_ENDPOINT or AZURE_ANTHROPIC_API_KEY not set' };
  }

  // Check WhatsApp Cloud API (if configured — not used with Twilio but kept for completeness)
  if (process.env.WHATSAPP_ACCESS_TOKEN) {
    try {
      const { messaging } = await import('@ekatra/messaging');
      const start = Date.now();
      const healthy = await messaging.checkHealth();
      checks.whatsapp = { 
        status: healthy ? 'healthy' : 'unavailable', 
        latency: Date.now() - start 
      };
    } catch (error: any) {
      checks.whatsapp = { status: 'unavailable', error: error.message };
    }
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    checks
  });
});

/**
 * GET /health/live
 * Liveness probe - is the process alive
 */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    pid: process.pid,
    memory: process.memoryUsage()
  });
});

/**
 * GET /health/dashboard
 * Dashboard data for admin UI
 */
healthRouter.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    // Return mock data if database not available
    const mockData = {
      overview: {
        totalLearners: 0,
        activeLearners: 0,
        completedLearners: 0,
        totalCourses: 0,
        publishedCourses: 0,
        messagesToday: 0,
        messagesThisWeek: 0
      },
      system: {
        uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
        memory: process.memoryUsage(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      }
    };

    try {
      const { db } = await import('@ekatra/database');
      const [learnerStats, courseStats, messageStats] = await Promise.all([
        db.learners.getStats().catch(() => ({ total: 0, active: 0, completed: 0 })),
        db.courses.getStats().catch(() => ({ total: 0, published: 0 })),
        db.messageLog.getStats().catch(() => ({ total: 0, today: 0 }))
      ]);

      res.json({
        success: true,
        data: {
          overview: {
            totalLearners: learnerStats.total,
            activeLearners: learnerStats.active,
            completedLearners: learnerStats.completed,
            totalCourses: courseStats.total,
            publishedCourses: courseStats.published,
            messagesToday: messageStats.today,
            messagesThisWeek: messageStats.thisWeek
          },
          system: mockData.system
        }
      });
    } catch {
      // Database not available, return mock
      res.json({
        success: true,
        data: mockData,
        note: 'Database not connected - showing default values'
      });
    }
  } catch (error) {
    logger.error('Error fetching dashboard data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard' });
  }
});

/**
 * POST /health/test-whatsapp
 * Test WhatsApp connection by sending a test message
 */
healthRouter.post('/test-whatsapp', async (req: Request, res: Response) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required'
      });
    }

    const { messaging } = await import('@ekatra/messaging');
    await messaging.sendText(phoneNumber, {
      text: `✅ Ekatra WhatsApp connection test successful!\n\nTimestamp: ${new Date().toISOString()}`
    });

    res.json({
      success: true,
      message: 'Test message sent successfully'
    });
  } catch (error: any) {
    logger.error('WhatsApp test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default healthRouter;
