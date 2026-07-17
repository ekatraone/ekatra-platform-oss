import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

const getDb = () => import('@ekatra/database').then(m => m.db);

export const analyticsRouter: Router = Router();

analyticsRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const [learnerStats, courseStats, messageStats, enrollmentStats] = await Promise.all([
      db.learners.getStats(),
      db.courses.getStats(),
      db.messageLog.getStats(),
      db.enrollments.getStats(),
    ]);

    const totalEnrollments = Number(enrollmentStats.total || 0);
    const completedEnrollments = Number(enrollmentStats.completed || 0);

    res.json({
      success: true,
      data: {
        totalUsers: Number(learnerStats.total || 0),
        activeCourses: Number(courseStats.published || 0),
        completionRate: totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0,
        messagesSent: Number(messageStats.outbound || 0),
      },
    });
  } catch (error) {
    logger.error('Error fetching analytics stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

analyticsRouter.get('/analytics', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const days = Math.max(7, Math.min(90, Number(req.query.days || 30)));

    const [dailyMessages, dailyRegistrations, deliveryStats, completionBreakdown] = await Promise.all([
      db.messageLog.getDailyVolume(days),
      db.learners.getDailyRegistrations(days),
      db.messageLog.getDeliveryStats(),
      db.enrollments.getCompletionBreakdown(),
    ]);

    const registrationsByLabel = new Map(
      dailyRegistrations.map((row: any) => [row.label, Number(row.registrations || 0)])
    );

    const outboundTotal = Number(deliveryStats.sent || 0);
    const delivered = Number(deliveryStats.delivered || 0);
    const read = Number(deliveryStats.read || 0);
    const failed = Number(deliveryStats.failed || 0);

    // completionBreakdown is [{status, count}, ...] — reduce to lookup map
    const breakdownMap: Record<string, number> = {};
    for (const row of completionBreakdown as Array<{ status: string; count: number }>) {
      breakdownMap[row.status] = Number(row.count || 0);
    }

    res.json({
      success: true,
      data: {
        engagement: dailyMessages.map((row: any) => ({
          label: row.label,
          registrations: registrationsByLabel.get(row.label) || 0,
          outbound: Number(row.outbound || 0),
          inbound: Number(row.inbound || 0),
        })),
        delivery: {
          outboundTotal,
          delivered,
          read,
          failed,
          deliveryRate: outboundTotal > 0 ? Math.round((delivered / outboundTotal) * 100) : 0,
          readRate: outboundTotal > 0 ? Math.round((read / outboundTotal) * 100) : 0,
        },
        courseCompletion: [
          { name: 'Completed', value: breakdownMap['completed'] || 0 },
          { name: 'In Progress', value: breakdownMap['in_progress'] || 0 },
          { name: 'Not Started', value: breakdownMap['not_started'] || 0 },
        ],
      },
    });
  } catch (error) {
    logger.error('Error fetching analytics data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

analyticsRouter.get('/courses/stats', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data = await db.courses.getPerformanceStats();

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error fetching course analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course stats' });
  }
});

export default analyticsRouter;