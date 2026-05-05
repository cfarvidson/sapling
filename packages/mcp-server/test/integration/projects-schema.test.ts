import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects schema (migration 007)', () => {
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

  it('creates the projects table with the expected columns', async () => {
    const cols = await db.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='projects'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual([
      'id',
      'app_id',
      'title',
      'description_md',
      'definition_of_done_md',
      'linear_url',
      'status',
      'failure_reason',
      'created_at',
      'updated_at',
    ]);
    expect(cols.rows.find((r) => r.column_name === 'app_id')?.is_nullable).toBe('NO');
    expect(cols.rows.find((r) => r.column_name === 'linear_url')?.is_nullable).toBe('YES');
  });

  it('creates the project_status enum with all six values', async () => {
    const { rows } = await db.pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname='project_status'
        ORDER BY enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([
      'pending',
      'scoping',
      'in_progress',
      'done',
      'blocked',
      'cancelled',
    ]);
  });

  it('adds project_id to plans and work_items as nullable FK', async () => {
    const cols = await db.pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public'
          AND column_name='project_id'
          AND table_name IN ('plans','work_items')
        ORDER BY table_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: 'plans', column_name: 'project_id', is_nullable: 'YES' },
      { table_name: 'work_items', column_name: 'project_id', is_nullable: 'YES' },
    ]);
  });

  it('adds is_dod_verifier to work_items as NOT NULL DEFAULT false', async () => {
    const { rows } = await db.pool.query<{
      column_name: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_items' AND column_name='is_dod_verifier'`,
    );
    expect(rows[0]).toMatchObject({
      column_name: 'is_dod_verifier',
      is_nullable: 'NO',
    });
    expect(rows[0].column_default).toMatch(/false/);
  });

  it('cascades project deletion when an app is deleted', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('proj-cascade-app')`);
    const app = await db.pool.query<{ id: number }>(
      `SELECT id FROM apps WHERE name='proj-cascade-app'`,
    );
    await db.pool.query(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md)
       VALUES ($1, 't', 'd', 'dod')`,
      [app.rows[0].id],
    );
    await db.pool.query(`DELETE FROM apps WHERE id=$1`, [app.rows[0].id]);
    const after = await db.pool.query(`SELECT id FROM projects`);
    expect(after.rowCount).toBe(0);
  });

  it('sets project_id to NULL on plans/work_items when project is deleted', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('proj-set-null-app')`);
    const app = await db.pool.query<{ id: number }>(
      `SELECT id FROM apps WHERE name='proj-set-null-app'`,
    );
    const proj = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md)
       VALUES ($1, 't', 'd', 'dod') RETURNING id`,
      [app.rows[0].id],
    );
    const w = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown, project_id)
       VALUES ('code', 't', 'd', $1) RETURNING id`,
      [proj.rows[0].id],
    );
    await db.pool.query(`DELETE FROM projects WHERE id=$1`, [proj.rows[0].id]);
    const { rows } = await db.pool.query(`SELECT project_id FROM work_items WHERE id=$1`, [
      w.rows[0].id,
    ]);
    expect(rows[0].project_id).toBeNull();
  });
});
