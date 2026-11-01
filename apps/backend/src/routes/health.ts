/**
 * Health & System API Routes
 * 
 * Health checks, metrics, and system status
 */

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

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
  const { checkReadiness } = await import('../lib/readiness.js');
  const { db } = await import('@ekatra/database');
  const { getRedis } = await import('../lib/redis.js');
  const redis = getRedis();
  const result = await checkReadiness({
    database: async () => { await db.raw('SELECT 1'); },
    redis: async () => {
      if (!redis) throw new Error('Redis not configured');
      if (await redis.ping() !== 'PONG') throw new Error('Redis unavailable');
    },
  });
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: result.checks,
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
healthRouter.get('/dashboard', authMiddleware, requireRole('super_admin'), async (_req: Request, res: Response) => {
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
healthRouter.post('/test-whatsapp', authMiddleware, requireRole('super_admin'),
  rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false }),
  async (req: Request, res: Response) => {
  try {
    const { phoneNumber } = req.body;
    
    if (typeof phoneNumber !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required'
      });
    }

    const { messaging } = await import('@ekatra/messaging');
    const result = await messaging.sendText(phoneNumber, {
      text: `✅ Ekatra WhatsApp connection test successful!\n\nTimestamp: ${new Date().toISOString()}`
    });

    if (!result.success) return res.status(502).json({ success: false, error: 'Provider rejected test message' });
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
