/**
 * Shared certificate service
 *
 * Generates a PDF certificate for course completion.
 * Stores the PDF as base64 in learner metadata and serves it via the Railway URL.
 * No external storage credentials required — self-hosted on the same service.
 *
 * Rate limiting: re-uses a cached certificate for 24 hours.
 */

import PDFDocument from 'pdfkit';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const getDb = () => import('@ekatra/database').then(m => m.db);

// ─── Sanitization ───────────────────────────────────────────────────────────

/**
 * Strip characters that break PDF rendering and truncate to maxLength.
 * Covers AC2 criteria: removes < > { } [ ] \ and trims whitespace.
 */
export function sanitizeForPDF(text: unknown, maxLength: number): string {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text.replace(/[<>{}[\]\\]/g, '').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength - 3) + '...';
}

// ─── PDF Generation ──────────────────────────────────────────────────────────

/**
 * Generate a certificate PDF buffer.
 * Returns a Buffer suitable for base64 encoding or streaming.
 */
export async function generateCertificatePDF(
  learnerName: string,
  courseTitle: string,
  completedAt: Date,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 60, bottom: 60, left: 70, right: 70 },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const safeName = sanitizeForPDF(learnerName, 50) || 'Learner';
    const safeCourse = sanitizeForPDF(courseTitle, 100) || 'Course';
    const dateStr = completedAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // ── Border ──
    doc
      .rect(doc.page.margins.left - 20, doc.page.margins.top - 20,
        doc.page.width - (doc.page.margins.left + doc.page.margins.right) + 40,
        doc.page.height - (doc.page.margins.top + doc.page.margins.bottom) + 40)
      .lineWidth(3)
      .strokeColor('#1a1a2e')
      .stroke();

    // ── Header ──
    doc
      .font('Helvetica-Bold')
      .fontSize(36)
      .fillColor('#1a1a2e')
      .text('EKATRA', { align: 'center' });

    doc
      .font('Helvetica')
      .fontSize(13)
      .fillColor('#555')
      .text('Bite-sized learning, real-world results', { align: 'center' });

    doc.moveDown(1.5);

    // ── Certificate of Completion ──
    doc
      .font('Helvetica')
      .fontSize(14)
      .fillColor('#888')
      .text('CERTIFICATE OF COMPLETION', { align: 'center', characterSpacing: 2 });

    doc.moveDown(0.8);

    // ── This is to certify ──
    doc
      .font('Helvetica')
      .fontSize(14)
      .fillColor('#333')
      .text('This is to certify that', { align: 'center' });

    doc.moveDown(0.5);

    // ── Learner Name ──
    doc
      .font('Helvetica-Bold')
      .fontSize(32)
      .fillColor('#1a1a2e')
      .text(safeName, { align: 'center' });

    doc.moveDown(0.5);

    // ── Course line ──
    doc
      .font('Helvetica')
      .fontSize(14)
      .fillColor('#333')
      .text('has successfully completed', { align: 'center' });

    doc.moveDown(0.4);

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#2d6a4f')
      .text(safeCourse, { align: 'center' });

    doc.moveDown(1.2);

    // ── Divider ──
    const midX = doc.page.width / 2;
    doc
      .moveTo(midX - 120, doc.y)
      .lineTo(midX + 120, doc.y)
      .lineWidth(1)
      .strokeColor('#aaa')
      .stroke();

    doc.moveDown(0.8);

    // ── Date ──
    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor('#666')
      .text(`Completed on ${dateStr}`, { align: 'center' });

    doc.moveDown(1);

    // ── Powered by line ──
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#aaa')
      .text('Powered by Ekatra · WhatsApp Learning Platform', { align: 'center' });

    doc.end();
  });
}

// ─── Issue / Cache / URL ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WEBHOOK_BASE_URL || 'http://localhost:3000';

/**
 * Check if a cached certificate is still valid (< 24 hrs old).
 * Returns the cached URL or null. When `course` is given, the cached
 * certificate is only reused if it was issued for that same course (by id when
 * both sides have one, otherwise by title) — a learner finishing a second
 * course within 24h must not be handed the first course's certificate.
 */
export function getCachedCertificate(learner: any, course?: { id?: string; title?: string }): string | null {
  const meta = learner.metadata || {};
  const generatedAt: string | undefined = meta.certificateGeneratedAt;
  const url: string | undefined = meta.certificateUrl;
  if (!generatedAt || !url || !meta.certificateAccessToken || !url.includes('token=')) return null;
  if (course) {
    const sameCourse = course.id && meta.certificateCourseId
      ? meta.certificateCourseId === course.id
      : meta.certificateCourse === sanitizeForPDF(course.title, 100);
    if (!sameCourse) return null;
  }
  const age = Date.now() - new Date(generatedAt).getTime();
  return age < CACHE_TTL_MS ? url : null;
}

export function matchesCertificateAccessToken(supplied: unknown, expected: unknown): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || supplied.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

/**
 * Generate, store, and return a certificate URL for a learner/course pair.
 * Respects 24-hour cache — returns existing URL if still fresh.
 */
export async function issueCertificate(
  learner: any,
  courseTitle: string,
  courseId?: string,
): Promise<{ url: string; fromCache: boolean }> {
  // Cache check — only for the same course
  const cached = getCachedCertificate(learner, { id: courseId, title: courseTitle });
  if (cached) return { url: cached, fromCache: true };

  const db = await getDb();

  // Generate
  const pdfBuffer = await generateCertificatePDF(
    learner.name || 'Learner',
    courseTitle,
    new Date(),
  );
  const base64 = pdfBuffer.toString('base64');
  const accessToken = randomBytes(32).toString('base64url');
  const url = `${RAILWAY_URL}/api/certificates/${learner.id}?token=${encodeURIComponent(accessToken)}`;

  // Persist in metadata
  const existing = learner.metadata || {};
  await db.learners.update(learner.id, {
    metadata: {
      ...existing,
      certificateBase64: base64,
      certificateUrl: url,
      certificateAccessToken: accessToken,
      certificateGeneratedAt: new Date().toISOString(),
      certificateCourse: sanitizeForPDF(courseTitle, 100),
      certificateCourseId: courseId, // undefined drops a stale id from a previous course
    },
  });

  return { url, fromCache: false };
}
