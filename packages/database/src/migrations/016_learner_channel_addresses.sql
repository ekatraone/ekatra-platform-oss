-- App-only learners (Google/email via Firebase) are addressed "fb:<uid>", like "tg:<chat_id>" for
-- Telegram. A Firebase uid can be up to 128 characters, which does not fit VARCHAR(20).
ALTER TABLE learners ALTER COLUMN phone TYPE VARCHAR(140);
ALTER TABLE failed_messages ALTER COLUMN phone TYPE VARCHAR(140);
