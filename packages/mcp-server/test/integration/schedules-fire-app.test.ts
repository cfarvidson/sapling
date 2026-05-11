import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { fireSchedule } from '../../src/schedules/fire.js';
import { findScheduleByIdOrName, recentRuns } from '../../src/schedules/db.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';

const log = createLogger('error');

async function makeAppWithServices(
  db: TestDb,
): Promise<{ appId: number; svc1: number; svc2: number }> {
  await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
  const a = await db.pool.query<{ id: number }>(
    `INSERT INTO apps(name) VALUES ('fire-app') RETURNING id`,
  );
  const appId = a.rows[0].id;
  const s1 = await db.pool.query<{ id: number }>(
    `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 's1', 'https://github.com/x/s1.git') RETURNING id`,
    [appId],
  );
  const s2 = await db.pool.query<{ id: number }>(
    `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 's2', 'https://github.com/x/s2.git') RETURNING id`,
    [appId],
  );
  return { appId, svc1: s1.rows[0].id, svc2: s2.rows[0].id };
}

async function createAppSchedule(
  db: TestDb,
  appId: number,
  overlap = 'skip_if_running',
): Promise<number> {
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO schedules
       (name, source_type, app_id, cron_expr, timezone, overlap_policy,
        title_template, description_md, definition_of_done_md, next_run_at)
     VALUES ('weekly','app',$1,'0 9 * * 1','UTC',$2,'Weekly review {{date}}',
             'review repos','reviews posted', now() - interval '1 minute')
     RETURNING id`,
    [appId, overlap],
  );
  return r.rows[0].id;
}

describe('fireSchedule — app source', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE schedule_runs, schedules RESTART IDENTITY CASCADE`);
  });

  it('fires a project with service fan-out and records a "fired" run', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId);
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;

    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('fired');
    expect(runs[0].project_id).not.toBeNull();

    const { rows: projRows } = await db.pool.query(`SELECT status FROM projects WHERE id = $1`, [
      runs[0].project_id,
    ]);
    expect(projRows[0].status).toBe('in_progress');

    const after = (await findScheduleByIdOrName(db.pool, schedId))!;
    expect(after.last_fired_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('records "skipped_overlap" when the prior project is non-terminal', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId);

    const sched1 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched1, log, now: new Date() });

    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched2 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched2, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs[0].status).toBe('skipped_overlap');
    expect(runs).toHaveLength(2);
  });

  it('with always_fire policy, ignores prior project state', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId, 'always_fire');
    const sched1 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched1, log, now: new Date() });

    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched2 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched2, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs.every((r) => r.status === 'fired')).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('records "failed" with error when the app has no services', async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('empty-app') RETURNING id`,
    );
    const schedId = await createAppSchedule(db, a.rows[0].id);
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/no services/i);
    const after = (await findScheduleByIdOrName(db.pool, schedId))!;
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('renders {{date}} and {{iso_date}} in the title', async () => {
    const { appId } = await makeAppWithServices(db);
    const r = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('templated','app',$1,'0 9 * * 1','UTC','skip_if_running',
               'Review on {{date}} ({{iso_date}})',
               'd','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    const schedId = r.rows[0].id;
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    const now = new Date('2026-05-11T12:00:00Z');
    await fireSchedule({ db: db.pool, schedule: sched, log, now });
    const runs = await recentRuns(db.pool, schedId, 1);
    const { rows: pj } = await db.pool.query<{ title: string }>(
      `SELECT title FROM projects WHERE id = $1`,
      [runs[0].project_id],
    );
    expect(pj[0].title).toContain('2026-05-11');
    expect(pj[0].title).toContain('2026-05-11T12:00:00.000Z');
  });

  it('overlap guard survives an intervening skipped_overlap run (regression for C4)', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId);

    // fire1 — creates project P (in_progress).
    const sched1 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched1, log, now: new Date() });

    // fire2 — should skip; records a skipped_overlap row.
    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched2 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched2, log, now: new Date() });

    // fire3 — must ALSO skip, because the underlying P from fire1 is still in_progress.
    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched3 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched3, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    // 1 fired + 2 skipped_overlap
    expect(runs.filter((r) => r.status === 'fired')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'skipped_overlap')).toHaveLength(2);
  });
});
