/**
 * Database Seed Script
 * 
 * Populates the database with sample data for development
 */

import pg from 'pg';

const { Pool } = pg;

async function seed() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ekatra:ekatra_dev_password@localhost:5432/ekatra'
  });

  console.log('🌱 Seeding database...');

  try {
    // Create sample courses
    const courses = await pool.query(`
      INSERT INTO courses (title, description, total_days, language, category, is_published)
      VALUES 
        ('Growth Mindset for Leaders', 'A 3-day journey to develop a growth mindset', 3, 'en', 'Leadership', true),
        ('Effective Communication', 'Master the art of workplace communication', 5, 'en', 'Communication', true),
        ('Stress Management Basics', 'Learn to manage stress effectively', 3, 'en', 'Wellness', false)
      ON CONFLICT DO NOTHING
      RETURNING id, title
    `);
    console.log(`✅ Created ${courses.rowCount} courses`);

    if (courses.rows.length > 0) {
      const courseId = courses.rows[0].id;

      // Create course content for first course
      await pool.query(`
        INSERT INTO course_content (course_id, day_number, day_title, module_number, content_type, content, caption)
        VALUES 
          -- Day 1
          ($1, 1, 'Understanding Mindset', 0, 'text', 'Welcome to Day 1! 🎉\n\nToday we explore what mindset really means and why it matters.', NULL),
          ($1, 1, 'Understanding Mindset', 1, 'text', 'A *growth mindset* is the belief that abilities can be developed through dedication and hard work.', NULL),
          ($1, 1, 'Understanding Mindset', 2, 'quiz', 'Quick check: Which describes a growth mindset?', NULL),
          
          -- Day 2
          ($1, 2, 'Fixed vs Growth', 0, 'text', 'Day 2: Fixed vs Growth Mindset\n\nLet''s dive deeper into the differences.', NULL),
          ($1, 2, 'Fixed vs Growth', 1, 'text', 'Fixed mindset: "I''m either good at it or not."\nGrowth mindset: "I can learn anything I want to."', NULL),
          ($1, 2, 'Fixed vs Growth', 2, 'text', 'Reflect on a time you faced a challenge. Did you embrace it or avoid it?', NULL),
          
          -- Day 3  
          ($1, 3, 'Applying Growth Mindset', 0, 'text', 'Final Day: Putting it into practice! 💪', NULL),
          ($1, 3, 'Applying Growth Mindset', 1, 'text', 'Three steps to cultivate growth mindset:\n1. Embrace challenges\n2. Learn from feedback\n3. Celebrate effort, not just results', NULL),
          ($1, 3, 'Applying Growth Mindset', 2, 'text', 'Congratulations on completing the course! 🎉\n\nRemember: Your brain is like a muscle - it grows with exercise.', NULL)
        ON CONFLICT DO NOTHING
      `, [courseId]);
      console.log(`✅ Created course content for: ${courses.rows[0].title}`);

      // Update quiz options
      await pool.query(`
        UPDATE course_content 
        SET quiz_options = '["I am either good at something or I am not", "I can learn anything with practice", "Talent is fixed at birth"]',
            correct_answer = 1,
            feedback = 'Correct! A growth mindset is about believing you can improve with effort.'
        WHERE course_id = $1 AND day_number = 1 AND content_type = 'quiz'
      `, [courseId]);

      // Create a schedule
      await pool.query(`
        INSERT INTO schedules (course_id, push_time, timezone, days_of_week, is_active)
        VALUES ($1, '09:00', 'Asia/Kolkata', ARRAY[1,2,3,4,5,6,7], true)
        ON CONFLICT DO NOTHING
      `, [courseId]);
      console.log('✅ Created schedule');
    }

    // Create sample learners
    const learners = await pool.query(`
      INSERT INTO learners (wa_id, name, language, current_mode)
      VALUES 
        ('919876543210', 'Test User 1', 'en', 'structured'),
        ('919876543211', 'Test User 2', 'en', 'structured'),
        ('919876543212', 'Test User 3', 'hi', 'structured')
      ON CONFLICT DO NOTHING
      RETURNING id, name
    `);
    console.log(`✅ Created ${learners.rowCount} sample learners`);

    console.log('\n✅ Database seeded successfully!');
    console.log('\nSample data:');
    console.log('- 3 courses (2 published, 1 draft)');
    console.log('- Course content for "Growth Mindset for Leaders"');
    console.log('- 3 sample learners');
    console.log('- 1 active schedule (9 AM IST daily)');

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
