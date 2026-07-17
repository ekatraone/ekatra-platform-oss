#!/usr/bin/env node
/**
 * Ekatra Database Migration Script
 * Run: npx tsx migrate.ts
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required');
    console.log('\nSet it in your .env file:');
    console.log('DATABASE_URL=postgresql://user:pass@host/db?sslmode=require');
    process.exit(1);
  }

  console.log('🔄 Connecting to database...');
  
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Get migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`\n📁 Found ${files.length} migration files`);

    for (const file of files) {
      console.log(`\n🔄 Running ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      try {
        await client.query(sql);
        console.log(`✅ ${file} completed`);
      } catch (err: any) {
        // Ignore "already exists" errors for idempotent migrations
        if (err.message?.includes('already exists') || 
            err.message?.includes('duplicate key')) {
          console.log(`⏭️  ${file} - already applied (skipping)`);
        } else {
          throw err;
        }
      }
    }

    console.log('\n✅ All migrations completed successfully!');
    
    // Verify tables
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('\n📋 Tables in database:');
    result.rows.forEach(row => console.log(`   - ${row.table_name}`));

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
