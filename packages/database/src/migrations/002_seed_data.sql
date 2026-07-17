-- Ekatra Seed Data
-- Initial data for demo/development

-- Create default organization
INSERT INTO organizations (id, name, slug, settings) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Ekatra Demo', 'ekatra-demo', '{"features": ["whatsapp", "ai_tutor"]}')
ON CONFLICT (slug) DO NOTHING;

-- Create admin user (password: admin123 - hashed with bcrypt)
INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 
   'admin@ekatra.com', '$2b$10$rOzJqQZQMqMqMqMqMqMqMeOzJqQZQMqMqMqMqMqMqMeOzJqQZQMq', 
   'Admin User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Create sample courses
INSERT INTO courses (id, organization_id, title, description, category, status, created_by) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
   'WhatsApp Marketing Basics', 
   'Learn the fundamentals of marketing through WhatsApp Business API',
   'Marketing', 'published', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
   'Customer Service Excellence', 
   'Master customer service skills for the digital age',
   'Customer Service', 'published', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001',
   'Product Knowledge Training', 
   'Comprehensive product training for sales teams',
   'Sales', 'draft', '00000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- Create lessons for WhatsApp Marketing course
INSERT INTO lessons (id, course_id, title, content, sequence_order, duration_minutes) VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010',
   'Introduction to WhatsApp Business',
   'Welcome to WhatsApp Marketing! 📱

WhatsApp has over 2 billion users worldwide, making it the most popular messaging app. In this course, you''ll learn how to leverage WhatsApp Business API for marketing.

Key benefits:
• 98% open rates (vs 20% for email)
• Direct, personal communication
• Rich media support
• Two-way conversations

Tomorrow, we''ll dive into setting up your WhatsApp Business profile.',
   1, 5),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010',
   'Setting Up Your Business Profile',
   'Your WhatsApp Business profile is your digital storefront. 🏪

Essential elements:
1. **Business Name** - Clear and recognizable
2. **Profile Photo** - Your logo or product image
3. **Description** - What you do in 256 characters
4. **Business Hours** - When you''re available
5. **Website & Email** - Additional contact options

💡 Pro tip: Use a professional photo and keep your description benefit-focused!',
   2, 5),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000010',
   'Message Templates',
   'Message templates are pre-approved messages for outbound communication. 📝

Types of templates:
• **Transactional** - Order updates, confirmations
• **Marketing** - Promotions, announcements
• **OTP** - Verification codes

Template best practices:
✅ Keep messages concise
✅ Include clear call-to-action
✅ Use variables for personalization
❌ Avoid spammy language
❌ Don''t mislead users',
   3, 5)
ON CONFLICT DO NOTHING;

-- Create lessons for Customer Service course
INSERT INTO lessons (id, course_id, title, content, sequence_order, duration_minutes) VALUES
  ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000011',
   'The Customer Service Mindset',
   'Great customer service starts with the right mindset! 🌟

Core principles:
1. **Empathy First** - Understand the customer''s perspective
2. **Active Listening** - Hear what they''re really saying
3. **Solution Focus** - Find ways to help, not excuses
4. **Patience** - Every customer deserves your best

Remember: A happy customer tells 3 people. An unhappy customer tells 10.',
   1, 5),
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000011',
   'Handling Difficult Conversations',
   'Difficult customers are opportunities in disguise. 💪

The HEAT method:
• **H**ear them out completely
• **E**mpathize with their situation
• **A**pologize sincerely (for their experience)
• **T**ake action to resolve

Phrases that help:
✅ "I understand how frustrating this must be"
✅ "Let me see what I can do for you"
✅ "Thank you for bringing this to our attention"',
   2, 5)
ON CONFLICT DO NOTHING;

-- Create sample learners
INSERT INTO learners (id, organization_id, phone, name, email, status) VALUES
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000001',
   '+919876543210', 'Rahul Kumar', 'rahul@example.com', 'active'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001',
   '+919876543211', 'Priya Sharma', 'priya@example.com', 'active'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001',
   '+919876543212', 'Amit Patel', 'amit@example.com', 'active'),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001',
   '+919876543213', 'Sneha Reddy', 'sneha@example.com', 'paused'),
  ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001',
   '+919876543214', 'Vikram Singh', 'vikram@example.com', 'active')
ON CONFLICT DO NOTHING;

-- Create enrollments
INSERT INTO enrollments (id, learner_id, course_id, status, progress, started_at) VALUES
  ('00000000-0000-0000-0000-000000000200', '00000000-0000-0000-0000-000000000100',
   '00000000-0000-0000-0000-000000000010', 'in_progress', 66, NOW() - INTERVAL '5 days'),
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000010', 'completed', 100, NOW() - INTERVAL '10 days'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102',
   '00000000-0000-0000-0000-000000000011', 'in_progress', 50, NOW() - INTERVAL '3 days'),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000100',
   '00000000-0000-0000-0000-000000000011', 'enrolled', 0, NOW())
ON CONFLICT DO NOTHING;

-- Create schedules
INSERT INTO schedules (id, course_id, name, schedule_type, days_of_week, send_time, is_active) VALUES
  ('00000000-0000-0000-0000-000000000300', '00000000-0000-0000-0000-000000000010',
   'Weekday Morning', 'daily', ARRAY[1,2,3,4,5], '09:00', true),
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000011',
   'Daily Afternoon', 'daily', ARRAY[1,2,3,4,5,6,7], '14:00', true)
ON CONFLICT DO NOTHING;
