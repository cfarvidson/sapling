import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/rest', () => import('../__mocks__/@octokit/rest.js'));

import { runMigrations } from '../../src/migrate.js';
import { fireSchedule } from '../../src/schedules/fire.js';
import { findScheduleByIdOrName, recentRuns } from '../../src/schedules/db.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';
import { __resetMock, __state } from '../__mocks__/@octokit/rest.js';

const log = createLogger('error');

describe('fireSchedule — github_org source', () => {
  let db: TestDb;
  let appId: number;
  let schedId: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    __resetMock();
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    await db.pool.query(`UPDATE runner_config SET github_token = NULL WHERE id = 1`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('gh-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    const r = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, github_org, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('gh-weekly','github_org',$1,'my-org','0 9 * * 1','UTC','skip_if_running',
               'GH review {{date}}','d','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    schedId = r.rows[0].id;
  });

  it('fails with "github_token not configured" when token is null', async () => {
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/github_token/i);
  });

  it('discovers repos, auto-creates services, and fires a project', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    __state.repos = [
      {
        name: 'r1',
        clone_url: 'https://github.com/my-org/r1.git',
        default_branch: 'main',
        archived: false,
      },
      {
        name: 'r2',
        clone_url: 'https://github.com/my-org/r2.git',
        default_branch: 'main',
        archived: false,
      },
    ];
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('fired');
    const { rowCount } = await db.pool.query(`SELECT 1 FROM services WHERE app_id = $1`, [appId]);
    expect(rowCount).toBe(2);
  });

  it('reuses existing service when repo_url matches', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    await db.pool.query(
      `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 'existing', 'https://github.com/my-org/r1.git')`,
      [appId],
    );
    __state.repos = [
      {
        name: 'r1',
        clone_url: 'https://github.com/my-org/r1.git',
        default_branch: 'main',
        archived: false,
      },
    ];
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const { rowCount } = await db.pool.query(`SELECT 1 FROM services WHERE app_id = $1`, [appId]);
    expect(rowCount).toBe(1);
  });

  it('records failure on Octokit error', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    __state.shouldThrow = new Error('rate limited');
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/rate limited|github listOrgRepos/i);
  });
});
