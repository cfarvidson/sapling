import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('teams schema (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
  });

  it('creates teams, team_roles, team_defaults tables and adds work_items.team_id', async () => {
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('teams','team_roles','team_defaults')`,
    );
    expect(new Set(tables.rows.map((r) => r.table_name))).toEqual(
      new Set(['teams', 'team_roles', 'team_defaults']),
    );

    const col = await db.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_items' AND column_name='team_id'`,
    );
    expect(col.rows[0]).toMatchObject({ column_name: 'team_id', is_nullable: 'YES' });
  });

  it('rejects two global teams with the same name (NULLS NOT DISTINCT)', async () => {
    await db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('global', 'lead')`);
    await expect(
      db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('global', 'lead')`),
    ).rejects.toThrow(/duplicate/i);
  });

  it('allows the same team name globally and per-app', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('iris')`);
    const app = await db.pool.query<{ id: number }>(`SELECT id FROM apps WHERE name='iris'`);
    await db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('code-review', 'g')`);
    await db.pool.query(
      `INSERT INTO teams(name, app_id, lead_prompt_md) VALUES ('code-review', $1, 'a')`,
      [app.rows[0].id],
    );
    const { rows } = await db.pool.query(`SELECT name, app_id FROM teams ORDER BY id`);
    expect(rows).toHaveLength(2);
  });
});
