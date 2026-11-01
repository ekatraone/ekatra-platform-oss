import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export interface Migration { name: string; sql: string; checksum: string; }

export async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (names.length === 0) throw new Error('No SQL migrations found');
  return Promise.all(names.map(async name => {
    const sql = await readFile(path.join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

/** One connection owns the lock, transactions and ledger for the entire run. */
export async function runMigrations(client: pg.Client, migrations: Migration[]): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock(172931, 1)');
  try {
    const ledger = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
    if (!ledger.rows[0].name) {
      const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      if (tables.rowCount) {
        throw new Error('Existing schema has no migration ledger. Reconcile and baseline an isolated copy before upgrading; automatic adoption is disabled.');
      }
      await client.query(`CREATE TABLE public.schema_migrations (
        name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    }
    const applied = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations ORDER BY name');
    const byName = new Map(migrations.map(m => [m.name, m]));
    for (const row of applied.rows) {
      if (byName.get(row.name)?.checksum !== row.checksum) {
        throw new Error(`Applied migration is missing or changed: ${row.name}`);
      }
    }
    const known = new Set(applied.rows.map(row => row.name));
    const lastApplied = applied.rows.at(-1)?.name;
    const outOfOrder = migrations.find(m => !known.has(m.name) && m.name !== '002_seed_data.sql' && lastApplied && m.name < lastApplied);
    if (outOfOrder) throw new Error(`New migration precedes the applied ledger: ${outOfOrder.name}`);
    const completed: string[] = [];
    for (const migration of migrations) {
      // Historical demo fixtures are not a schema migration. Never seed production implicitly.
      if (known.has(migration.name) || migration.name === '002_seed_data.sql') continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
        completed.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${migration.name}`, { cause: error });
      }
    }
    return completed;
  } finally {
    await client.query('SELECT pg_advisory_unlock(172931, 1)');
  }
}
