import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { tick } from '../../src/schedules/scheduler.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';
import { recentRuns } from '../../src/schedules/db.js';

const log = createLogger('error');

describe('scheduler tick', () => {
  let db: TestDb;
  let appId: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('tick-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    await db.pool.query(`INSERT INTO services(app_id, name) VALUES ($1, 'svc')`, [appId]);
  });

  it('fires due schedules and skips not-due ones', async () => {
    const due = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('due','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('not-due','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() + interval '1 hour')`,
      [appId],
    );

    const summary = await tick(db.pool, log);
    expect(summary.due).toBe(1);
    expect(summary.fired).toBe(1);

    const runs = await recentRuns(db.pool, due.rows[0].id, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('fired');
  });

  it('ignores disabled schedules even if next_run_at is past', async () => {
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at, enabled)
       VALUES ('off','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() - interval '1 minute', FALSE)`,
      [appId],
    );
    const summary = await tick(db.pool, log);
    expect(summary.due).toBe(0);
  });
});
