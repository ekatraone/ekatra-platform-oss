import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { runMigrations, type Migration } from '../migrationRunner.js';

// Explicit test connection only. Never load DATABASE_URL or application .env files.
const testUrl = process.env.TEST_POSTGRES_URL;
const socket = process.env.TEST_POSTGRES_SOCKET;
const enabled = Boolean(testUrl || socket);
const migration = (name: string, sql: string): Migration => ({
  name, sql, checksum: createHash('sha256').update(sql).digest('hex'),
});

test('migration ledger, replay, checksums, rollback and legacy-schema refusal', { skip: !enabled }, async () => {
  const name = `ekatra_migration_test_${randomUUID().replaceAll('-', '')}`;
  const config = testUrl ? { connectionString: testUrl } : { host: socket, database: 'postgres' };
  const owner = new pg.Client(config);
  let client: pg.Client | undefined;
  await owner.connect();
  try {
    await owner.query(`CREATE DATABASE "${name}"`);
    const databaseConfig = testUrl
      ? { connectionString: (() => { const url = new URL(testUrl); url.pathname = `/${name}`; return url.toString(); })() }
      : { host: socket, database: name };
    client = new pg.Client(databaseConfig);
    await client.connect();
    const initial = migration('001_initial.sql', 'CREATE TABLE example (id INTEGER PRIMARY KEY)');
    const seed = migration('002_seed_data.sql', 'INSERT INTO example VALUES (99)');
    assert.deepEqual(await runMigrations(client, [initial, seed]), [initial.name]);
    assert.deepEqual(await runMigrations(client, [initial, seed]), []);
    assert.equal((await client.query('SELECT * FROM example')).rowCount, 0);
    await assert.rejects(runMigrations(client, [migration(initial.name, 'SELECT 2')]), /missing or changed/);

    const broken = migration('003_broken.sql', 'ALTER TABLE example ADD COLUMN rolled_back TEXT; SELECT * FROM nonexistent_table');
    await assert.rejects(runMigrations(client, [initial, broken]), /Migration failed/);
    assert.equal((await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'example' AND column_name = 'rolled_back'")).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM schema_migrations')).rowCount, 1);

    const upgrade = migration('003_upgrade.sql', 'ALTER TABLE example ADD COLUMN value TEXT');
    assert.deepEqual(await runMigrations(client, [initial, upgrade]), [upgrade.name]);
    assert.deepEqual(await runMigrations(client, [initial, upgrade]), []);
    await assert.rejects(runMigrations(client, [initial, migration('002_late.sql', 'SELECT 1'), upgrade]), /precedes the applied ledger/);

    // Simulate a pre-ledger installation in this disposable database only.
    await client.query('DROP TABLE schema_migrations');
    await assert.rejects(runMigrations(client, [initial]), /Existing schema has no migration ledger/);
    assert.equal((await client.query('SELECT * FROM example')).rowCount, 0);
  } finally {
    await client?.end();
    await owner.query(`DROP DATABASE IF EXISTS "${name}"`);
    await owner.end();
  }
});
