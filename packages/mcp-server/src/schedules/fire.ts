import type pino from 'pino';
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';
import { nextCronTick } from '../cron.js';
import { listOrgRepos } from '../github.js';
import { createProjectInTx } from '../tools/projects.js';
import { advanceNextRun, recordRun, type ScheduleRow } from './db.js';
import { upsertServicesFromGitHub } from './services.js';

export interface FireArgs {
  db: Db;
  schedule: ScheduleRow;
  log: pino.Logger;
  now: Date;
}

function renderTitle(template: string, now: Date, tz: string): string {
  const isoDate = now.toISOString();
  const dateInTz = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return template.replaceAll('{{date}}', dateInTz).replaceAll('{{iso_date}}', isoDate);
}

async function resolveServiceIds(
  db: Db,
  schedule: ScheduleRow,
): Promise<{ kind: 'ok'; service_ids: number[] } | { kind: 'fail'; error: string }> {
  if (schedule.source_type === 'app') {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM services WHERE app_id = $1`, [
      schedule.app_id,
    ]);
    if (rows.length === 0) return { kind: 'fail', error: 'no services in app' };
    return { kind: 'ok', service_ids: rows.map((r) => r.id) };
  }

  // github_org path
  const cfg = await db.query<{ github_token: string | null; github_default_visibility: string }>(
    `SELECT github_token, github_default_visibility FROM runner_config WHERE id = 1`,
  );
  const token = cfg.rows[0]?.github_token;
  const visibility = (cfg.rows[0]?.github_default_visibility ?? 'all') as
    | 'all'
    | 'public'
    | 'private';
  if (!token) return { kind: 'fail', error: 'github_token not configured' };

  let repos;
  try {
    repos = await listOrgRepos(token, schedule.github_org!, visibility);
  } catch (err) {
    return { kind: 'fail', error: `github listOrgRepos failed: ${(err as Error).message}` };
  }
  if (repos.length === 0)
    return { kind: 'fail', error: `no repos discovered for org ${schedule.github_org}` };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await upsertServicesFromGitHub(client, {
      app_id: schedule.app_id,
      schedule_id: schedule.id,
      repos,
    });
    await client.query('COMMIT');
    return { kind: 'ok', service_ids: out.service_ids };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { kind: 'fail', error: `service upsert failed: ${(err as Error).message}` };
  } finally {
    client.release();
  }
}

async function hasNonTerminalLastProject(
  client: PoolClient,
  schedule_id: number,
): Promise<boolean> {
  const { rows } = await client.query<{ status: string | null }>(
    `SELECT p.status
       FROM schedule_runs sr
       LEFT JOIN projects p ON p.id = sr.project_id
       WHERE sr.schedule_id = $1 AND sr.project_id IS NOT NULL
       ORDER BY sr.fired_at DESC LIMIT 1`,
    [schedule_id],
  );
  const status = rows[0]?.status;
  return (
    status === 'pending' || status === 'scoping' || status === 'in_progress' || status === 'blocked'
  );
}

export type FireOutcome =
  | { status: 'fired'; project_id: number; duration_ms: number }
  | { status: 'skipped_overlap' }
  | { status: 'failed'; error: string };

export async function fireSchedule(args: FireArgs): Promise<FireOutcome> {
  const { db, schedule, log, now } = args;
  const start = Date.now();
  const advanceDate = nextCronTick(schedule.cron_expr, schedule.timezone, now);

  const resolved = await resolveServiceIds(db, schedule);
  if (resolved.kind === 'fail') {
    await recordFailure(db, schedule.id, advanceDate, resolved.error, Date.now() - start);
    log.warn({
      event: 'schedule_fire',
      schedule_id: schedule.id,
      status: 'failed',
      error: resolved.error,
    });
    return { status: 'failed', error: resolved.error };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (schedule.overlap_policy === 'skip_if_running') {
      const overlap = await hasNonTerminalLastProject(client, schedule.id);
      if (overlap) {
        await recordRun(client, { schedule_id: schedule.id, status: 'skipped_overlap' });
        await advanceNextRun(client, schedule.id, advanceDate, false);
        await client.query('COMMIT');
        log.info({
          event: 'schedule_fire',
          schedule_id: schedule.id,
          status: 'skipped_overlap',
        });
        return { status: 'skipped_overlap' };
      }
    }

    const title = renderTitle(schedule.title_template, now, schedule.timezone);
    const result = await createProjectInTx(client, {
      app_id: schedule.app_id,
      app_name: '',
      title,
      description_md: schedule.description_md,
      definition_of_done_md: schedule.definition_of_done_md,
      service_ids: resolved.service_ids,
    });

    const duration_ms = Date.now() - start;
    await recordRun(client, {
      schedule_id: schedule.id,
      status: 'fired',
      project_id: result.project.id as number,
      duration_ms,
    });
    await advanceNextRun(client, schedule.id, advanceDate, true);
    await client.query('COMMIT');
    log.info({
      event: 'schedule_fire',
      schedule_id: schedule.id,
      source_type: schedule.source_type,
      project_id: result.project.id,
      status: 'fired',
      durationMs: duration_ms,
    });
    return { status: 'fired', project_id: result.project.id as number, duration_ms };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const msg = (err as Error).message;
    await recordFailure(db, schedule.id, advanceDate, msg, Date.now() - start);
    log.error({ event: 'schedule_fire', schedule_id: schedule.id, status: 'failed', error: msg });
    return { status: 'failed', error: msg };
  } finally {
    client.release();
  }
}

async function recordFailure(
  db: Db,
  schedule_id: number,
  next_run_at: Date,
  error: string,
  duration_ms: number,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await recordRun(client, { schedule_id, status: 'failed', error, duration_ms });
    await advanceNextRun(client, schedule_id, next_run_at, false);
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }
}
