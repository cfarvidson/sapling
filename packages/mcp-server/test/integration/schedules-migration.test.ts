import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('migration 011 schedules', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  it('creates schedules and schedule_runs tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('schedules','schedule_runs')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(['schedule_runs', 'schedules']);
  });

  it('adds github_token and github_default_visibility to runner_config', async () => {
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='runner_config'
          AND column_name IN ('github_token','github_default_visibility')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'github_default_visibility',
      'github_token',
    ]);
  });

  it('rejects schedules with mismatched source_type/github_org', async () => {
    const { rows: appRows } = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('mig011-app') RETURNING id`,
    );
    const appId = appRows[0].id;
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, github_org, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('s1', 'app', $1, 'should-be-null', '0 * * * *',
                 't', 'd', 'dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, github_org, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('s2', 'github_org', $1, NULL, '0 * * * *',
                 't', 'd', 'dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE on schedules.name', async () => {
    const { rows: appRows } = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('mig011-app2') RETURNING id`,
    );
    const appId = appRows[0].id;
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, title_template,
          description_md, definition_of_done_md, next_run_at)
       VALUES ('dup-name','app',$1,'0 * * * *','t','d','dod', now())`,
      [appId],
    );
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('dup-name','app',$1,'0 * * * *','t','d','dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
  });
});
