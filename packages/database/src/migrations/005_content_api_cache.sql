-- Migration 005: Content API cache persistence
-- Stores Twilio Content API SIDs keyed by the quick-reply button fingerprint.
-- Survives Railway redeployments, preventing duplicate Content API template creation.

CREATE TABLE IF NOT EXISTS content_api_cache (
  cache_key  TEXT PRIMARY KEY,
  content_sid TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
