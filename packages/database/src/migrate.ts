#!/usr/bin/env node
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { readMigrations, runMigrations } from './migrationRunner.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    ssl: process.env.DATABASE_DISABLE_SSL === 'true' ? false : { rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const migrations = await readMigrations(fileURLToPath(new URL('./migrations/', import.meta.url)));
    const completed = await runMigrations(client, migrations);
    console.log(`Migrations complete: ${completed.length} applied`);
    for (const name of completed) console.log(name);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
