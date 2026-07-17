-- Ekatra Platform Database Schema
-- Adapted from microlearn-main/supabase/migrations
-- PostgreSQL with pgvector extension

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============ LEARNERS ============

CREATE TABLE IF NOT EXISTS learners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wa_id VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT 'Unknown',
  language VARCHAR(10) DEFAULT 'en',
  current_course_id UUID,
  current_day INTEGER DEFAULT 0,
  current_module INTEGER DEFAULT 0,
  course_status VARCHAR(50), -- enrolled, in_progress, completed, dropped
  in_qa_session BOOLEAN DEFAULT FALSE,
  current_mode VARCHAR(50) DEFAULT 'structured', -- structured, alfred
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_learners_wa_id ON learners(wa_id);
CREATE INDEX idx_learners_course ON learners(current_course_id);
CREATE INDEX idx_learners_status ON learners(course_status);

-- ============ COURSES ============

CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  total_days INTEGER NOT NULL DEFAULT 1,
  language VARCHAR(10) DEFAULT 'en',
  category VARCHAR(100),
  is_published BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_courses_published ON courses(is_published);
CREATE INDEX idx_courses_category ON courses(category);

-- ============ COURSE CONTENT ============

CREATE TABLE IF NOT EXISTS course_content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL,
  day_title VARCHAR(255),
  module_number INTEGER NOT NULL DEFAULT 0,
  content_type VARCHAR(50) NOT NULL, -- text, image, video, audio, quiz, document
  content TEXT,
  media_url TEXT,
  quiz_options JSONB, -- Array of options for quiz
  correct_answer INTEGER, -- Index of correct answer
  caption TEXT,
  feedback TEXT, -- Feedback for quiz answers
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_content_course ON course_content(course_id);
CREATE INDEX idx_content_day ON course_content(course_id, day_number);
CREATE UNIQUE INDEX idx_content_unique ON course_content(course_id, day_number, module_number);

-- ============ USER PROGRESS ============

CREATE TABLE IF NOT EXISTS user_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'in_progress', -- in_progress, completed, dropped
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  dropped_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(learner_id, course_id)
);

CREATE INDEX idx_progress_learner ON user_progress(learner_id);
CREATE INDEX idx_progress_course ON user_progress(course_id);

-- ============ MESSAGES ============

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL, -- inbound, outbound
  message_type VARCHAR(50) NOT NULL, -- text, image, video, audio, document, interactive
  content TEXT,
  wa_message_id VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_learner ON messages(learner_id);
CREATE INDEX idx_messages_created ON messages(created_at);

-- ============ SCHEDULES ============

CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  push_time TIME NOT NULL, -- e.g., '09:00'
  timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
  days_of_week INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6,7], -- 1=Mon, 7=Sun
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(course_id)
);

CREATE INDEX idx_schedules_active ON schedules(is_active);

-- ============ PUSH LOGS ============

CREATE TABLE IF NOT EXISTS push_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL,
  learners_pushed INTEGER DEFAULT 0,
  errors TEXT[],
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_push_logs_schedule ON push_logs(schedule_id);
CREATE INDEX idx_push_logs_created ON push_logs(created_at);

-- ============ Q&A SESSIONS ============

CREATE TABLE IF NOT EXISTS qa_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  day_number INTEGER,
  turn_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_qa_sessions_learner ON qa_sessions(learner_id);
CREATE INDEX idx_qa_sessions_active ON qa_sessions(learner_id) WHERE ended_at IS NULL;

-- ============ Q&A MESSAGES ============

CREATE TABLE IF NOT EXISTS qa_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL, -- user, assistant
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_qa_messages_session ON qa_messages(session_id);

-- ============ LEARNER RESPONSES ============

CREATE TABLE IF NOT EXISTS learner_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  day_number INTEGER,
  module_number INTEGER,
  response TEXT,
  is_correct BOOLEAN,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_responses_learner ON learner_responses(learner_id);

-- ============ ACTIVITY LOG ============

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(50) NOT NULL, -- user_registered, course_started, day_completed, etc.
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_activity_created ON activity_log(created_at);

-- ============ DOCUMENT EMBEDDINGS (for RAG) ============

CREATE TABLE IF NOT EXISTS document_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1536), -- OpenAI text-embedding-ada-002 dimension
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_embeddings_course ON document_embeddings(course_id);

-- ============ FUNCTIONS ============

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER learners_updated_at BEFORE UPDATE ON learners
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER courses_updated_at BEFORE UPDATE ON courses
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON schedules
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Similarity search function for RAG
CREATE OR REPLACE FUNCTION search_documents(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.78,
  match_count INT DEFAULT 5,
  filter_course_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  course_id UUID,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.id,
    de.content,
    de.course_id,
    1 - (de.embedding <=> query_embedding) AS similarity
  FROM document_embeddings de
  WHERE 
    (filter_course_id IS NULL OR de.course_id = filter_course_id)
    AND 1 - (de.embedding <=> query_embedding) > match_threshold
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
