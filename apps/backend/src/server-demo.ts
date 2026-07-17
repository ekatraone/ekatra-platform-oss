/**
 * Minimal Ekatra Backend Server (for testing without database)
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app: express.Application = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ========== Health Routes ==========
const startTime = new Date();

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime.getTime()) / 1000)
  });
});

app.get('/health/ready', (_req, res) => {
  res.json({
    status: 'demo-mode',
    timestamp: new Date().toISOString(),
    note: 'Database not connected - running in demo mode'
  });
});

app.get('/health/dashboard', (_req, res) => {
  res.json({
    success: true,
    data: {
      overview: {
        totalLearners: 125,
        activeLearners: 42,
        completedLearners: 83,
        totalCourses: 5,
        publishedCourses: 3,
        messagesToday: 156,
        messagesThisWeek: 892
      },
      system: {
        uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
        memory: process.memoryUsage(),
        version: '1.0.0',
        environment: 'demo'
      }
    }
  });
});

// ========== Mock Courses ==========
const mockCourses = [
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    title: 'Introduction to Management',
    instructor: 'John Smith',
    description: 'Learn the fundamentals of modern management',
    category: 'Business',
    language: 'English',
    price: 99,
    status: 'published',
    enrolledCount: 42,
    createdAt: '2024-01-15T10:00:00Z',
    days: [
      { dayNumber: 1, title: 'Day 1: Foundations', content: 'Welcome to the course!' },
      { dayNumber: 2, title: 'Day 2: Leadership', content: 'Leadership principles...' },
      { dayNumber: 3, title: 'Day 3: Strategy', content: 'Strategic thinking...' }
    ]
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    title: 'Digital Marketing Essentials',
    instructor: 'Jane Doe',
    description: 'Master digital marketing from scratch',
    category: 'Marketing',
    language: 'English',
    price: 79,
    status: 'draft',
    enrolledCount: 0,
    createdAt: '2024-01-20T10:00:00Z',
    days: []
  }
];

app.get('/api/courses', (_req, res) => {
  res.json({
    success: true,
    courses: mockCourses,
    pagination: { page: 1, limit: 20, total: mockCourses.length }
  });
});

app.get('/api/courses/:id', (req, res) => {
  const course = mockCourses.find(c => c.id === req.params.id);
  if (course) {
    res.json({ success: true, course });
  } else {
    res.status(404).json({ success: false, error: 'Course not found' });
  }
});

app.post('/api/courses', (req, res) => {
  const newCourse = {
    id: `550e8400-e29b-41d4-a716-${Date.now()}`,
    ...req.body,
    enrolledCount: 0,
    createdAt: new Date().toISOString()
  };
  mockCourses.push(newCourse);
  res.json({ success: true, course: newCourse });
});

// ========== Mock Learners ==========
const mockLearners = [
  { id: '1', name: 'Amit Kumar', waId: '919876543210', courseStatus: 'active', currentDay: 2 },
  { id: '2', name: 'Priya Singh', waId: '919876543211', courseStatus: 'completed', currentDay: 3 },
  { id: '3', name: 'Rahul Sharma', waId: '919876543212', courseStatus: 'active', currentDay: 1 }
];

app.get('/api/learners', (_req, res) => {
  res.json({
    success: true,
    learners: mockLearners,
    pagination: { page: 1, limit: 20, total: mockLearners.length }
  });
});

// ========== Mock Schedules ==========
const mockSchedules = [
  {
    id: 'sched-1',
    courseId: '550e8400-e29b-41d4-a716-446655440001',
    courseTitle: 'Introduction to Management',
    schedule: '09:00 Asia/Kolkata',
    timezone: 'Asia/Kolkata',
    isPaused: false,
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    createdAt: '2024-01-15T10:00:00Z'
  }
];

app.get('/api/schedules', (_req, res) => {
  res.json(mockSchedules);
});

app.post('/api/schedules', (req, res) => {
  const newSchedule = {
    id: `sched-${Date.now()}`,
    ...req.body,
    isPaused: false,
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString()
  };
  mockSchedules.push(newSchedule);
  res.json({ success: true, schedule: newSchedule });
});

app.put('/api/schedules/:id', (req, res) => {
  const schedule = mockSchedules.find(s => s.id === req.params.id);
  if (schedule) {
    Object.assign(schedule, req.body);
    res.json({ success: true, schedule });
  } else {
    res.status(404).json({ success: false, error: 'Schedule not found' });
  }
});

app.post('/api/schedules/:id/trigger', (req, res) => {
  console.log(`🚀 Manual push triggered for schedule ${req.params.id}`);
  res.json({ 
    success: true, 
    message: 'Push triggered (demo mode)',
    learnersNotified: 3
  });
});

app.get('/api/schedules/logs', (_req, res) => {
  res.json([
    { id: 'log-1', scheduleId: 'sched-1', status: 'success', recipientCount: 42, successCount: 41, createdAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'log-2', scheduleId: 'sched-1', status: 'success', recipientCount: 42, successCount: 42, createdAt: new Date(Date.now() - 172800000).toISOString() }
  ]);
});

// ========== Webhooks (placeholder) ==========
app.post('/api/webhooks/whatsapp', (req, res) => {
  console.log('📱 WhatsApp webhook received:', JSON.stringify(req.body).substring(0, 200));
  res.sendStatus(200);
});

app.get('/api/webhooks/whatsapp', (req, res) => {
  // Webhook verification
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ success: false, error: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 Ekatra Backend Started (Demo Mode)');
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Dashboard API: http://localhost:${PORT}/health/dashboard`);
  console.log(`📚 Courses API: http://localhost:${PORT}/api/courses`);
  console.log('');
  console.log('⚠️  Running without database - using mock data');
  console.log('');
});

export default app;
