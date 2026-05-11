import type { PoolClient } from 'pg';
import type { Db } from '../db.js';

export type ScheduleSource = 'app' | 'github_org';
export type ScheduleOverlap = 'skip_if_running' | 'always_fire';
export type ScheduleRunStatus = 'fired' | 'skipped_overlap' | 'failed';

export interface ScheduleRow {
  id: number;
  name: string;
  source_type: ScheduleSource;
  app_id: number;
  github_org: string | null;
  cron_expr: string;
  timezone: string;
  overlap_policy: ScheduleOverlap;
  title_template: string;
  description_md: string;
  definition_of_done_md: string;
  enabled: boolean;
  last_fired_at: Date | null;
  next_run_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleRunRow {
  id: number;
  schedule_id: number;
  fired_at: Date;
  status: ScheduleRunStatus;
  project_id: number | null;
  error: string | null;
  duration_ms: number | null;
}

export async function findScheduleByIdOrName(
  db: Db | PoolClient,
  idOrName: number | string,
): Promise<ScheduleRow | null> {
  const sql =
    typeof idOrName === 'number'
      ? `SELECT * FROM schedules WHERE id = $1`
      : `SELECT * FROM schedules WHERE name = $1`;
  const { rows } = await db.query<ScheduleRow>(sql, [idOrName]);
  return rows[0] ?? null;
}

export async function listSchedules(
  db: Db,
  filters: { app_id?: number; source_type?: ScheduleSource; enabled?: boolean },
): Promise<ScheduleRow[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (filters.app_id !== undefined) {
    vals.push(filters.app_id);
    conds.push(`app_id = $${vals.length}`);
  }
  if (filters.source_type !== undefined) {
    vals.push(filters.source_type);
    conds.push(`source_type = $${vals.length}`);
  }
  if (filters.enabled !== undefined) {
    vals.push(filters.enabled);
    conds.push(`enabled = $${vals.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await db.query<ScheduleRow>(
    `SELECT * FROM schedules ${where} ORDER BY id ASC`,
    vals,
  );
  return rows;
}

export async function recordRun(
  client: PoolClient,
  args: {
    schedule_id: number;
    status: ScheduleRunStatus;
    project_id?: number | null;
    error?: string | null;
    duration_ms?: number | null;
  },
): Promise<ScheduleRunRow> {
  const { rows } = await client.query<ScheduleRunRow>(
    `INSERT INTO schedule_runs(schedule_id, status, project_id, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      args.schedule_id,
      args.status,
      args.project_id ?? null,
      args.error ?? null,
      args.duration_ms ?? null,
    ],
  );
  return rows[0];
}

export async function recentRuns(
  db: Db | PoolClient,
  schedule_id: number,
  limit: number,
): Promise<ScheduleRunRow[]> {
  const { rows } = await db.query<ScheduleRunRow>(
    `SELECT * FROM schedule_runs WHERE schedule_id = $1
      ORDER BY fired_at DESC LIMIT $2`,
    [schedule_id, limit],
  );
  return rows;
}

export async function advanceNextRun(
  client: PoolClient,
  schedule_id: number,
  next_run_at: Date,
  fired: boolean,
): Promise<void> {
  if (fired) {
    await client.query(
      `UPDATE schedules SET last_fired_at = now(), next_run_at = $2, updated_at = now()
        WHERE id = $1`,
      [schedule_id, next_run_at],
    );
  } else {
    await client.query(
      `UPDATE schedules SET next_run_at = $2, updated_at = now() WHERE id = $1`,
      [schedule_id, next_run_at],
    );
  }
}
