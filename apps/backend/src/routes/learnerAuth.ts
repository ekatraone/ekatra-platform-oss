import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { learnerAuthMiddleware, signLearnerToken } from '../middleware/learnerAuth.js';
import { listOTPProviders, verifyOTPToken } from '../services/otp/index.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

export const learnerAuthRouter: Router = Router();

learnerAuthRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    defaultProvider: (process.env.OTP_PROVIDER || 'firebase').toLowerCase(),
    providers: listOTPProviders(),
  });
});

learnerAuthRouter.post('/verify', async (req: Request, res: Response) => {
  try {
    const { provider, idToken, phoneNumber, name } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, error: 'idToken is required' });
    }

    const result = await verifyOTPToken({ provider, idToken, phoneNumber });
    const db = await getDb();
    let learner = await db.learners.findByPhone(result.phoneNumber);

    if (!learner) {
      const org = await db.organizations.getDefault();
      if (!org) {
        return res.status(500).json({ success: false, error: 'Default organization not found' });
      }

      learner = await db.learners.create({
        organizationId: org.id,
        phone: result.phoneNumber,
        whatsappId: result.phoneNumber,
        name: typeof name === 'string' ? name.trim() || 'Learner' : 'Learner',
        language: 'en',
        metadata: {
          auth: {
            otpProvider: result.provider,
            providerUserId: result.providerUserId,
          },
        },
      });
    } else {
      const metadata = {
        ...(learner.metadata || {}),
        auth: {
          ...((learner.metadata || {}).auth || {}),
          otpProvider: result.provider,
          providerUserId: result.providerUserId,
          lastVerifiedAt: new Date().toISOString(),
        },
      };
      learner = await db.learners.update(learner.id, { metadata }) || learner;
    }

    const token = signLearnerToken({
      learnerId: learner.id,
      phone: learner.phone,
      role: 'learner',
      organizationId: learner.organization_id,
    });

    logger.info(`Learner OTP login success: ${learner.phone} (${result.provider})`);

    res.json({
      success: true,
      token,
      learner: {
        id: learner.id,
        phone: learner.phone,
        name: learner.name,
        organizationId: learner.organization_id,
      },
      provider: result.provider,
    });
  } catch (error: any) {
    logger.error('Learner OTP verify failed:', error);
    res.status(401).json({ success: false, error: error?.message || 'OTP verification failed' });
  }
});

learnerAuthRouter.get('/me', learnerAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const learner = await db.learners.findById(req.learnerAuth!.learnerId);
    if (!learner) {
      return res.status(404).json({ success: false, error: 'Learner not found' });
    }

    res.json({
      success: true,
      learner: {
        id: learner.id,
        phone: learner.phone,
        name: learner.name,
        organizationId: learner.organization_id,
      },
    });
  } catch (error) {
    logger.error('Learner /me failed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch learner' });
  }
});
