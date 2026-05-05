import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';
import { advanceProjectAfterWorkCompletion } from './projects.js';

const WorkType = z.enum(['plan', 'code', 'review']);
const WorkStatus = z.enum([
  'pending',
  'claimed',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'awaiting_input',
]);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerWork(server: McpServer, db: Db): void {
  server.registerTool(
    'enqueue_work',
    {
      description:
        'Add a typed task to the queue (plan / code / review). team_id resolution: explicit value > per-app default for (service.app_id, type) > global default for (NULL, type) > null (solo agent). project_id optionally links the item to a project so server-side hooks can advance the workflow on completion.',
      inputSchema: {
        type: WorkType,
        title: z.string().min(1),
        description_markdown: z.string(),
        priority: z.number().int().default(0),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        branch: z.string().optional(),
        pr_url: z.string().url().optional(),
        team_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      try {
        let appId: number | null = null;
        if (input.service_id) {
          const svc = await db.query<{ app_id: number | null }>(
            `SELECT app_id FROM services WHERE id = $1`,
            [input.service_id],
          );
          if (svc.rowCount === 0)
            return errorToToolResult(
              new AppError('not_found', `service ${input.service_id} not found`),
            );
          appId = svc.rows[0].app_id;
        }

        if (input.project_id !== undefined) {
          const p = await db.query<{ app_id: number }>(
            `SELECT app_id FROM projects WHERE id = $1`,
            [input.project_id],
          );
          if (p.rowCount === 0)
            return errorToToolResult(
              new AppError('not_found', `project ${input.project_id} not found`),
            );
          if (appId !== null && p.rows[0].app_id !== appId) {
            return errorToToolResult(
              new AppError(
                'invalid_input',
                `project ${input.project_id} belongs to app ${p.rows[0].app_id} but service belongs to app ${appId}`,
              ),
            );
          }
        }

        let teamId: number | null = null;
        if (input.team_id !== undefined) {
          const t = await db.query<{ app_id: number | null }>(
            `SELECT app_id FROM teams WHERE id = $1`,
            [input.team_id],
          );
          if (t.rowCount === 0)
            return errorToToolResult(new AppError('not_found', `team ${input.team_id} not found`));
          const teamApp = t.rows[0].app_id;
          if (teamApp !== null && appId !== null && teamApp !== appId) {
            return errorToToolResult(
              new AppError(
                'invalid_input',
                `team ${input.team_id} is scoped to app ${teamApp} but service belongs to app ${appId}`,
              ),
            );
          }
          teamId = input.team_id;
        } else {
          // Resolution chain: per-app default → global default → null.
          if (appId !== null) {
            const perApp = await db.query<{ team_id: number }>(
              `SELECT team_id FROM team_defaults WHERE app_id = $1 AND work_type = $2`,
              [appId, input.type],
            );
            if ((perApp.rowCount ?? 0) > 0) teamId = perApp.rows[0].team_id;
          }
          if (teamId === null) {
            const global = await db.query<{ team_id: number }>(
              `SELECT team_id FROM team_defaults WHERE app_id IS NULL AND work_type = $1`,
              [input.type],
            );
            if ((global.rowCount ?? 0) > 0) teamId = global.rows[0].team_id;
          }
        }

        const { rows } = await db.query(
          `INSERT INTO work_items
             (type, title, description_markdown, priority, service_id, plan_id, branch, pr_url, team_id, project_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            input.type,
            input.title,
            input.description_markdown,
            input.priority,
            input.service_id ?? null,
            input.plan_id ?? null,
            input.branch ?? null,
            input.pr_url ?? null,
            teamId,
            input.project_id ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_work',
    {
      description: 'Fetch a single work item.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM work_items WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_work',
    {
      description:
        'List work items with optional filters. Each row includes app_id, app_name, and team_name (NULL if no team assigned).',
      inputSchema: {
        status: WorkStatus.optional(),
        type: WorkType.optional(),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        app_id: z.number().int().positive().optional(),
        app_name: z.string().min(1).optional(),
      },
    },
    async (filters) => {
      let resolvedAppId: number | null = filters.app_id ?? null;
      if (resolvedAppId === null && filters.app_name) {
        const lookup = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          filters.app_name,
        ]);
        if (lookup.rowCount === 0) {
          return errorToToolResult(new AppError('not_found', `app ${filters.app_name} not found`));
        }
        resolvedAppId = lookup.rows[0].id;
      }

      const conds: string[] = [];
      const vals: unknown[] = [];
      const directColumns: Array<keyof typeof filters> = [
        'status',
        'type',
        'service_id',
        'plan_id',
      ];
      for (const k of directColumns) {
        const v = filters[k];
        if (v === undefined) continue;
        vals.push(v);
        conds.push(`w.${k} = $${vals.length}`);
      }
      if (resolvedAppId !== null) {
        vals.push(resolvedAppId);
        conds.push(`s.app_id = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT w.*, s.app_id AS app_id, a.name AS app_name, tm.name AS team_name
           FROM work_items w
           LEFT JOIN services s ON s.id = w.service_id
           LEFT JOIN apps a ON a.id = s.app_id
           LEFT JOIN teams tm ON tm.id = w.team_id
           ${where}
           ORDER BY a.name NULLS LAST, w.priority DESC, w.created_at ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  // claim_next_work / complete_work / fail_work / cancel_work added in Tasks 13-14.
}

export function registerWorkLifecycle(server: McpServer, db: Db): void {
  server.registerTool(
    'complete_work',
    {
      description:
        'Mark a work item completed; optionally store a summary as an artifact, or link an existing artifact.',
      inputSchema: {
        id: z.number().int().positive(),
        summary_markdown: z.string().optional(),
        artifact_id: z.number().int().positive().optional(),
      },
    },
    async ({ id, summary_markdown, artifact_id }) => {
      try {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const upd = await client.query(
            `UPDATE work_items
                SET status = 'completed',
                    completed_at = now(),
                    claim_expires_at = NULL,
                    next_retry_at = NULL,
                    updated_at = now()
              WHERE id = $1
            RETURNING *`,
            [id],
          );
          if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return errorToToolResult(new AppError('not_found', `work ${id} not found`));
          }
          const work = upd.rows[0];
          if (summary_markdown) {
            await client.query(
              `INSERT INTO artifacts(kind, title, body_markdown, work_item_id)
               VALUES ('summary', $1, $2, $3)`,
              [`Summary: ${work.title}`, summary_markdown, id],
            );
          }
          if (artifact_id) {
            await client.query(`UPDATE artifacts SET work_item_id = $1 WHERE id = $2`, [
              id,
              artifact_id,
            ]);
          }
          if (work.project_id !== null && work.project_id !== undefined) {
            await advanceProjectAfterWorkCompletion(client, work.project_id, {
              id: work.id,
              project_id: work.project_id,
              plan_id: work.plan_id,
              type: work.type,
              is_dod_verifier: work.is_dod_verifier === true,
            });
          }
          await client.query('COMMIT');
          return ok(work);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'fail_work',
    {
      description: 'Mark a work item failed with a reason. Failed items are not auto-retried.',
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE work_items SET status='failed', failure_reason=$2, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, reason],
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'cancel_work',
    {
      description: 'Cancel a work item (soft delete equivalent).',
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().optional(),
      },
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE work_items
            SET status='cancelled',
                failure_reason=$2,
                claim_expires_at=NULL,
                next_retry_at=NULL,
                updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, reason ?? null],
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'block_work',
    {
      description:
        'Mark a work item blocked on an external dependency. claim_next_work skips blocked items; use unblock_work to flip back to pending.',
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE work_items
            SET status='blocked',
                failure_reason=$2,
                claim_expires_at=NULL,
                next_retry_at=NULL,
                updated_at=now()
          WHERE id=$1 AND status IN ('pending','claimed','blocked','failed') RETURNING *`,
        [id, reason],
      );
      if (rows.length === 0)
        return errorToToolResult(
          new AppError(
            'conflict',
            `work ${id} not found or in a terminal state (completed/cancelled)`,
          ),
        );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'reap_stuck_claims',
    {
      description:
        'Sweep claimed work items whose claim_expires_at has passed: transition to pending (or failed when attempt_count has reached max_claim_attempts), clear claim fields, and return the affected rows.',
      inputSchema: {
        now: z.string().datetime().optional(),
      },
    },
    async ({ now }) => {
      const { rows } = await db.query(
        `WITH cfg AS (
           SELECT max_claim_attempts FROM runner_config WHERE id = 1
         ),
         expired AS (
           SELECT w.id, w.attempt_count, w.claimed_by
             FROM work_items w
            WHERE w.status = 'claimed'
              AND w.claim_expires_at < coalesce($1::timestamptz, now())
            FOR UPDATE OF w SKIP LOCKED
         )
         UPDATE work_items w
            SET status = CASE
                  WHEN e.attempt_count >= (SELECT max_claim_attempts FROM cfg)
                    THEN 'failed'::work_status
                  ELSE 'pending'::work_status
                END,
                claimed_at = NULL,
                claimed_by = NULL,
                claim_expires_at = NULL,
                failure_reason = CASE
                  WHEN e.attempt_count >= (SELECT max_claim_attempts FROM cfg)
                    THEN format(
                      'reaped after %s attempts; last claimed_by=%s',
                      e.attempt_count,
                      coalesce(e.claimed_by, 'unknown')
                    )
                  ELSE NULL
                END,
                updated_at = now()
           FROM expired e
          WHERE w.id = e.id
         RETURNING w.id, w.status, w.attempt_count, e.claimed_by AS prior_claimed_by`,
        [now ?? null],
      );
      rows.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
      return ok(rows);
    },
  );

  server.registerTool(
    'retry_work',
    {
      description:
        'Re-queue a failed/blocked/claimed work item as pending. Optionally schedule the next claim by passing after_ms (delay in milliseconds; null/0 = retry immediately). Does not mutate attempt_count — explicit retries are clean retries.',
      inputSchema: {
        id: z.number().int().positive(),
        after_ms: z.number().int().nonnegative().optional(),
      },
    },
    async ({ id, after_ms }) => {
      const { rows } = await db.query(
        `UPDATE work_items
            SET status = 'pending',
                next_retry_at = CASE
                  WHEN $2::int IS NULL OR $2::int <= 0 THEN NULL
                  ELSE now() + ($2::int * interval '1 millisecond')
                END,
                claimed_at = NULL,
                claimed_by = NULL,
                claim_expires_at = NULL,
                failure_reason = NULL,
                updated_at = now()
          WHERE id = $1 AND status IN ('failed','blocked','claimed','awaiting_input')
          RETURNING *`,
        [id, after_ms ?? null],
      );
      if (rows.length === 0)
        return errorToToolResult(
          new AppError(
            'conflict',
            `work ${id} not found or in a terminal state (completed/cancelled)`,
          ),
        );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'unblock_work',
    {
      description: 'Flip a blocked work item back to pending so it can be claimed again.',
      inputSchema: {
        id: z.number().int().positive(),
      },
    },
    async ({ id }) => {
      const { rows } = await db.query(
        `UPDATE work_items
            SET status='pending', failure_reason=NULL, claimed_at=NULL, claimed_by=NULL, updated_at=now()
          WHERE id=$1 AND status='blocked' RETURNING *`,
        [id],
      );
      if (rows.length === 0)
        return errorToToolResult(
          new AppError('conflict', `work ${id} not found or not in 'blocked' state`),
        );
      return ok(rows[0]);
    },
  );
}

const WorkTypeArr = z.array(WorkType).min(1);

export function registerWorkClaim(server: McpServer, db: Db): void {
  server.registerTool(
    'claim_next_work',
    {
      description:
        'Atomically claim the next pending work item. Returns null if none. Use app_id or app_name to scope the claim to one app (joins through services).',
      inputSchema: {
        claimed_by: z.string().min(1),
        types: WorkTypeArr.optional(),
        service_id: z.number().int().positive().optional(),
        app_id: z.number().int().positive().optional(),
        app_name: z.string().min(1).optional(),
      },
    },
    async ({ claimed_by, types, service_id, app_id, app_name }) => {
      let resolvedAppId: number | null = app_id ?? null;
      if (resolvedAppId === null && app_name) {
        const lookup = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          app_name,
        ]);
        if (lookup.rowCount === 0) {
          return errorToToolResult(new AppError('not_found', `app ${app_name} not found`));
        }
        resolvedAppId = lookup.rows[0].id;
      }

      const { rows } = await db.query(
        `WITH cfg AS (
           SELECT max_claim_attempts, claim_ttl_ms FROM runner_config WHERE id = 1
         ),
         next AS (
           SELECT w.id FROM work_items w
            LEFT JOIN services s ON s.id = w.service_id
            WHERE w.status = 'pending'
              AND ($1::work_type[] IS NULL OR w.type = ANY($1))
              AND ($2::int IS NULL OR w.service_id = $2)
              AND ($3::int IS NULL OR s.app_id = $3)
              AND (w.next_retry_at IS NULL OR w.next_retry_at <= now())
              AND w.attempt_count < (SELECT max_claim_attempts FROM cfg)
            ORDER BY w.priority DESC, w.created_at ASC
            FOR UPDATE OF w SKIP LOCKED
            LIMIT 1
         )
         UPDATE work_items w
            SET status = 'claimed',
                claimed_at = now(),
                claimed_by = $4,
                claim_expires_at = now() + ((SELECT claim_ttl_ms FROM cfg) || ' milliseconds')::interval,
                attempt_count = w.attempt_count + 1,
                updated_at = now()
           FROM next
          WHERE w.id = next.id
         RETURNING w.*`,
        [types ?? null, service_id ?? null, resolvedAppId, claimed_by],
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows[0] ?? null) }] };
    },
  );
}
