import test from 'node:test';
import assert from 'node:assert/strict';
import { getCachedCertificate, matchesCertificateAccessToken } from '../services/certificateService.js';

test('certificate access requires the complete capability token', () => {
  assert.equal(matchesCertificateAccessToken('secret-token', 'secret-token'), true);
  assert.equal(matchesCertificateAccessToken('wrong-token', 'secret-token'), false);
  assert.equal(matchesCertificateAccessToken('', undefined), false);
});

test('legacy certificate URLs without a token are not reused', () => {
  const generatedAt = new Date().toISOString();
  assert.equal(getCachedCertificate({ metadata: {
    certificateGeneratedAt: generatedAt,
    certificateUrl: 'https://example.test/api/certificates/learner-id',
  } }), null);

  const securedUrl = 'https://example.test/api/certificates/learner-id?token=secret-token';
  assert.equal(getCachedCertificate({ metadata: {
    certificateGeneratedAt: generatedAt,
    certificateUrl: securedUrl,
    certificateAccessToken: 'secret-token',
  } }), securedUrl);
});

test('a cached certificate is only reused for the same course', () => {
  const learner = { metadata: {
    certificateGeneratedAt: new Date().toISOString(),
    certificateUrl: 'https://example.test/api/certificates/learner-id?token=secret-token',
    certificateAccessToken: 'secret-token',
    certificateCourse: 'Design Thinking',
    certificateCourseId: 'course-1',
  } };
  assert.equal(getCachedCertificate(learner, { id: 'course-1', title: 'Design Thinking' }), learner.metadata.certificateUrl);
  assert.equal(getCachedCertificate(learner, { id: 'course-2', title: 'Python Basics' }), null);
  // Legacy metadata without a course id falls back to the stored title
  const legacy = { metadata: { ...learner.metadata, certificateCourseId: undefined } };
  assert.equal(getCachedCertificate(legacy, { id: 'course-2', title: 'Python Basics' }), null);
  assert.equal(getCachedCertificate(legacy, { id: 'course-1', title: 'Design Thinking' }), learner.metadata.certificateUrl);
});
