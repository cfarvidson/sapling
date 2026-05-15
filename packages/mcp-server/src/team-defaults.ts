import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export type WorkType = 'plan' | 'code' | 'review';

/**
 * Resolve `team_defaults` for a given (app, work_type) using the same chain
 * `enqueue_work` uses: per-app default → global default → null.
 *
 * Used by both `enqueue_work` (where app_id flows from the service) and the
 * project auto-enqueue paths in `tools/projects.ts` (where app_id flows from
 * the project itself).
 */
export async function resolveTeamDefault(
  db: Queryable,
  appId: number | null,
  workType: WorkType,
): Promise<number | null> {
  if (appId !== null) {
    const perApp = await db.query<{ team_id: number }>(
      `SELECT team_id FROM team_defaults WHERE app_id = $1 AND work_type = $2`,
      [appId, workType],
    );
    if ((perApp.rowCount ?? 0) > 0) return perApp.rows[0].team_id;
  }
  const global = await db.query<{ team_id: number }>(
    `SELECT team_id FROM team_defaults WHERE app_id IS NULL AND work_type = $1`,
    [workType],
  );
  if ((global.rowCount ?? 0) > 0) return global.rows[0].team_id;
  return null;
}
