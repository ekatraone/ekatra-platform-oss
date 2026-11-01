-- Generated lesson images (Muse Image). Served publicly by GET /api/sync/media/:id so that
-- WhatsApp/Twilio can fetch them and the Maya app can cache them for offline use.
CREATE TABLE IF NOT EXISTS lesson_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('cover', 'module')),
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lesson_media_course ON lesson_media(course_id);
