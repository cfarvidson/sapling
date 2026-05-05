import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('migrate', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it('applies the initial migration and creates the expected tables', async () => {
    await runMigrations(db.pool);
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toEqual([
      '_migrations',
      'apps',
      'artifacts',
      'plans',
      'projects',
      'runner_config',
      'services',
      'team_defaults',
      'team_roles',
      'teams',
      'work_items',
    ]);
  });

  it('is idempotent — running twice does not fail or duplicate', async () => {
    const first = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM _migrations`,
    );
    await runMigrations(db.pool);
    const second = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM _migrations`,
    );
    expect(second.rows[0].count).toBe(first.rows[0].count);
  });
});
