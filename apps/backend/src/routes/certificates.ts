import { Router, Request, Response } from 'express';

const getDb = () => import('@ekatra/database').then(m => m.db);

export const certificatesRouter: Router = Router();

/**
 * GET /api/certificates/:learnerId
 *
 * Streams the learner's certificate PDF.
 * Public endpoint — no auth required (learner shares the URL via WhatsApp).
 */
certificatesRouter.get('/:learnerId', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const learner = await db.learners.findById(req.params.learnerId);

    if (!learner) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    const base64 = learner.metadata?.certificateBase64;
    if (!base64) {
      res.status(404).json({ error: 'Certificate not yet generated' });
      return;
    }

    const pdfBuffer = Buffer.from(base64, 'base64');
    const safeName = (learner.name || 'learner').replace(/[^a-z0-9]/gi, '_').toLowerCase();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="ekatra-certificate-${safeName}.pdf"`,
      'Content-Length': pdfBuffer.length.toString(),
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(pdfBuffer);
  } catch (err: any) {
    // Invalid UUID or DB error → treat as not found
    if (err?.message?.includes('invalid input syntax') || err?.code === '22P02') {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to retrieve certificate' });
  }
});
