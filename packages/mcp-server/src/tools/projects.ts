import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';
import { resolveTeamDefault } from '../team-defaults.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export interface CreateProjectInput {
  app_id: number;
  app_name: string;
  title: string;
  description_md: string;
  definition_of_done_md: string;
  linear_url?: string;
  service_ids?: number[];
}

export interface CreateProjectResult {
  project: Record<string, unknown>;
  scoping_work?: Record<string, unknown>;
  plan_work_items?: Record<string, unknown>[];
}

export async function createProjectInTx(
  client: PoolClient,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  if (!input.definition_of_done_md.trim()) {
    throw new AppError('invalid_input', 'definition_of_done_md must not be empty');
  }

  const fastPath = (input.service_ids?.length ?? 0) > 0;
  if (fastPath) {
    const services = await client.query<{ id: number; app_id: number; name: string }>(
      `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
      [input.service_ids],
    );
    if (services.rowCount !== input.service_ids!.length) {
      throw new AppError('not_found', 'one or more service_ids not found');
    }
    const wrong = services.rows.find((s) => s.app_id !== input.app_id);
    if (wrong) {
      throw new AppError(
        'invalid_input',
        `service ${wrong.id} (${wrong.name}) does not belong to app ${input.app_name}`,
      );
    }
  }

  const initialStatus = fastPath ? 'in_progress' : 'scoping';
  const projInsert = await client.query(
    `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, linear_url, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.app_id,
      input.title,
      input.description_md,
      input.definition_of_done_md,
      input.linear_url ?? null,
      initialStatus,
    ],
  );
  const project = projInsert.rows[0];

  if (!fastPath) {
    const scoping = await client.query(
      `INSERT INTO work_items(type, title, description_markdown, project_id)
       VALUES ('plan', $1, $2, $3)
       RETURNING *`,
      [
        `Scope project ${project.id}: ${project.title}`,
        `Scoping work for project ${project.id}.\n\n` +
          `Description:\n\n${project.description_md}\n\n` +
          `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
          `When you finish exploring, attach a 'scoping' artifact summarising which services are touched, ` +
          `then call complete_scoping(project_id=${project.id}, service_ids=[...]).`,
        project.id,
      ],
    );
    return { project, scoping_work: scoping.rows[0] };
  }

  const planWorkItems = [];
  for (const serviceId of input.service_ids!) {
    const w = await client.query(
      `INSERT INTO work_items(type, title, description_markdown, service_id, project_id)
       VALUES ('plan', $1, $2, $3, $4)
       RETURNING *`,
      [
        `Plan service ${serviceId} for project ${project.id}: ${project.title}`,
        `Per-service plan for project ${project.id} (service ${serviceId}).\n\n` +
          `Description:\n\n${project.description_md}\n\n` +
          `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
          `When you finish, call create_plan(project_id=${project.id}, service_id=${serviceId}, ...) ` +
          `and enqueue code work items beneath the new plan id.`,
        serviceId,
        project.id,
      ],
    );
    planWorkItems.push(w.rows[0]);
  }
  return { project, plan_work_items: planWorkItems };
}

export function registerProjects(server: McpServer, db: Db): void {
  server.registerTool(
    'create_project',
    {
      description:
        'Create a project for an app. Without service_ids → status starts at scoping and a single plan-type scoping work item is auto-enqueued. With service_ids → status starts at in_progress and one plan work item per service is fanned out (fast path). Atomic.',
      inputSchema: {
        app_name: z.string().min(1),
        title: z.string().min(1),
        description_md: z.string().min(1),
        definition_of_done_md: z.string(),
        linear_url: z.string().url().optional(),
        service_ids: z.array(z.number().int().positive()).optional(),
      },
    },
    async (input) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const appLookup = await client.query<{ id: number }>(
          `SELECT id FROM apps WHERE name = $1`,
          [input.app_name],
        );
        if (appLookup.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        }
        const appId = appLookup.rows[0].id;
        const result = await createProjectInTx(client, {
          app_id: appId,
          app_name: input.app_name,
          title: input.title,
          description_md: input.description_md,
          definition_of_done_md: input.definition_of_done_md,
          linear_url: input.linear_url,
          service_ids: input.service_ids,
        });
        await client.query('COMMIT');
        return ok(result);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof AppError) return errorToToolResult(err);
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    'complete_scoping',
    {
      description:
        'Atomically transition a project from scoping to in_progress and fan out one plan work item per service. Validates each service belongs to the project app. Caller separately calls complete_work on the scoping work item.',
      inputSchema: {
        project_id: z.number().int().positive(),
        service_ids: z.array(z.number().int().positive()),
      },
    },
    async (input) => {
      if (!input.service_ids || input.service_ids.length === 0) {
        return errorToToolResult(
          new AppError('invalid_input', 'service_ids must contain at least one entry'),
        );
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const projLookup = await client.query<{
          id: number;
          app_id: number;
          status: string;
          title: string;
          description_md: string;
          definition_of_done_md: string;
        }>(
          `SELECT id, app_id, status, title, description_md, definition_of_done_md FROM projects WHERE id = $1 FOR UPDATE`,
          [input.project_id],
        );
        if (projLookup.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(
            new AppError('not_found', `project ${input.project_id} not found`),
          );
        }
        const project = projLookup.rows[0];
        if (project.status !== 'scoping') {
          await client.query('ROLLBACK');
          return errorToToolResult(
            new AppError(
              'conflict',
              `project ${input.project_id} is in status ${project.status}; complete_scoping requires 'scoping'`,
            ),
          );
        }

        const services = await client.query<{ id: number; app_id: number; name: string }>(
          `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
          [input.service_ids],
        );
        if (services.rowCount !== input.service_ids.length) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', 'one or more service_ids not found'));
        }
        const wrong = services.rows.find((s) => s.app_id !== project.app_id);
        if (wrong) {
          await client.query('ROLLBACK');
          return errorToToolResult(
            new AppError(
              'invalid_input',
              `service ${wrong.id} (${wrong.name}) does not belong to project ${input.project_id}'s app`,
            ),
          );
        }

        const planWorkItems = [];
        for (const sid of input.service_ids) {
          const w = await client.query(
            `INSERT INTO work_items(type, title, description_markdown, service_id, project_id)
             VALUES ('plan', $1, $2, $3, $4)
             RETURNING *`,
            [
              `Plan service ${sid} for project ${project.id}: ${project.title}`,
              `Per-service plan for project ${project.id} (service ${sid}).\n\n` +
                `Description:\n\n${project.description_md}\n\n` +
                `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
                `Read the latest 'scoping' artifact on this project before planning.`,
              sid,
              project.id,
            ],
          );
          planWorkItems.push(w.rows[0]);
        }

        const upd = await client.query(
          `UPDATE projects SET status='in_progress', updated_at=now() WHERE id=$1 RETURNING *`,
          [project.id],
        );
        await client.query('COMMIT');
        return ok({ project: upd.rows[0], plan_work_items: planWorkItems });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    'get_project',
    {
      description:
        'Fetch a project plus rolled-up child counts: plan_count, work_counts grouped by status, latest scoping_artifact_id, and dod_verifier_id if present.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const proj = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
      if (proj.rowCount === 0)
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));

      const planCount = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM plans WHERE project_id = $1`,
        [id],
      );
      const workCounts = await db.query<{ status: string; n: number }>(
        `SELECT status::text AS status, count(*)::int AS n
           FROM work_items
          WHERE project_id = $1
          GROUP BY status`,
        [id],
      );
      const counts: Record<string, number> = {};
      for (const r of workCounts.rows) counts[r.status] = r.n;
      const scoping = await db.query<{ id: number }>(
        `SELECT a.id FROM artifacts a
           JOIN work_items w ON w.id = a.work_item_id
          WHERE w.project_id = $1 AND a.kind = 'scoping'
          ORDER BY a.created_at DESC LIMIT 1`,
        [id],
      );
      const verifier = await db.query<{ id: number }>(
        `SELECT id FROM work_items WHERE project_id = $1 AND is_dod_verifier = true ORDER BY id DESC LIMIT 1`,
        [id],
      );

      return ok({
        project: proj.rows[0],
        plan_count: planCount.rows[0].n,
        work_counts: counts,
        scoping_artifact_id: scoping.rows[0]?.id ?? null,
        dod_verifier_id: verifier.rows[0]?.id ?? null,
      });
    },
  );

  const ProjectStatus = z.enum([
    'pending',
    'scoping',
    'in_progress',
    'done',
    'blocked',
    'cancelled',
  ]);

  server.registerTool(
    'list_projects',
    {
      description:
        'List projects (titles + structured fields, no description or DoD bodies) optionally filtered by app_name or status.',
      inputSchema: {
        app_name: z.string().min(1).optional(),
        status: ProjectStatus.optional(),
      },
    },
    async ({ app_name, status }) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (app_name !== undefined) {
        vals.push(app_name);
        conds.push(`a.name = $${vals.length}`);
      }
      if (status !== undefined) {
        vals.push(status);
        conds.push(`p.status = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT p.id, p.title, p.status, p.app_id, a.name AS app_name,
                p.linear_url, p.dod_cycle_count, p.created_at, p.updated_at
           FROM projects p
           JOIN apps a ON a.id = p.app_id
           ${where}
           ORDER BY p.id ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  server.registerTool(
    'update_project',
    {
      description:
        'Patch a project. Allowed fields: title, description_md, definition_of_done_md, linear_url. status and app_id are immutable here — use the lifecycle tools.',
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description_md: z.string().min(1).optional(),
        definition_of_done_md: z.string().min(1).optional(),
        linear_url: z.string().url().nullable().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(
        (k) => patch[k] !== undefined,
      );
      if (fields.length === 0)
        return errorToToolResult(new AppError('invalid_input', 'no fields to update'));

      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const f of fields) {
        sets.push(`${f} = $${i++}`);
        values.push(patch[f]);
      }
      sets.push(`updated_at = now()`);
      values.push(id);
      try {
        const { rows } = await db.query(
          `UPDATE projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'cancel_project',
    {
      description:
        'Cancel a project. Cascades cancel_work to all non-terminal child work items in the same transaction. Idempotent on already-cancelled.',
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().optional(),
      },
    },
    async ({ id, reason }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const proj = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM projects WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (proj.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        }
        await client.query(
          `UPDATE work_items
              SET status='cancelled',
                  failure_reason=COALESCE($2, failure_reason),
                  claim_expires_at=NULL,
                  next_retry_at=NULL,
                  updated_at=now()
            WHERE project_id = $1
              AND status IN ('pending','claimed','blocked','awaiting_input')`,
          [id, reason ?? null],
        );
        const out = await client.query(
          `UPDATE projects
              SET status='cancelled',
                  failure_reason=COALESCE($2, failure_reason),
                  updated_at=now()
            WHERE id=$1
          RETURNING *`,
          [id, reason ?? null],
        );
        await client.query('COMMIT');
        return ok(out.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    'block_project',
    {
      description:
        "Block a project on an external dependency from scoping/in_progress. Cascades child work items in 'pending' and 'awaiting_input' to 'blocked' (claimed children are left running — Sapling cannot kill agent processes). The reserved failure_reason prefix 'project blocked: ' marks cascade-blocked rows so unblock_project can target them. Reason is required.",
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ id, reason }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const updProj = await client.query(
          `UPDATE projects
              SET status='blocked',
                  failure_reason=$2,
                  updated_at=now()
            WHERE id=$1 AND status IN ('scoping','in_progress')
           RETURNING *`,
          [id, reason],
        );
        if (updProj.rowCount === 0) {
          await client.query('ROLLBACK');
          const exists = await db.query(`SELECT id FROM projects WHERE id=$1`, [id]);
          if (exists.rowCount === 0)
            return errorToToolResult(new AppError('not_found', `project ${id} not found`));
          return errorToToolResult(
            new AppError('conflict', `project ${id} is in a terminal state`),
          );
        }

        const cascade = await client.query(
          `UPDATE work_items
              SET status='blocked',
                  failure_reason=$2,
                  updated_at=now()
            WHERE project_id=$1
              AND status IN ('pending','awaiting_input')`,
          [id, `project blocked: ${reason}`],
        );

        await client.query('COMMIT');
        return ok({ project: updProj.rows[0], cascade_blocked_count: cascade.rowCount ?? 0 });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    'unblock_project',
    {
      description:
        'Unblock a project. Recomputes target state from children: scoping if a scoping plan-type work item is still pending/claimed, else in_progress. Cascade-unblocks children whose failure_reason starts with the reserved prefix "project blocked: ". Replays auto-enqueue triggers by iterating *every* completed non-verifier child in completed_at order (the helper is idempotent).',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const proj = await client.query<{
          id: number;
          status: string;
          failure_reason: string | null;
        }>(`SELECT id, status, failure_reason FROM projects WHERE id=$1 FOR UPDATE`, [id]);
        if (proj.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        }
        if (proj.rows[0].status !== 'blocked') {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('conflict', `project ${id} is not blocked`));
        }

        const scopingInFlight = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM work_items
             WHERE project_id = $1 AND type = 'plan'
               AND title LIKE 'Scope project%'
               AND status IN ('pending','claimed','awaiting_input','blocked')`,
          [id],
        );
        const target = scopingInFlight.rows[0].n > 0 ? 'scoping' : 'in_progress';
        const updProj = await client.query(
          `UPDATE projects
              SET status=$2, failure_reason=NULL, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [id, target],
        );

        const wasCapBlocked =
          proj.rows[0].failure_reason !== null &&
          /^DoD not verified after \d+ cycles$/.test(proj.rows[0].failure_reason);
        if (wasCapBlocked) {
          await client.query(
            `UPDATE projects SET dod_cycle_count = 0, updated_at = now() WHERE id = $1`,
            [id],
          );
        }

        // Cascade-unblock children carrying the reserved marker prefix.
        const cascade = await client.query(
          `UPDATE work_items
              SET status='pending',
                  failure_reason=NULL,
                  updated_at=now()
            WHERE project_id=$1
              AND status='blocked'
              AND failure_reason LIKE 'project blocked: %'`,
          [id],
        );

        // Replay non-verifier completions to re-fire auto-enqueue triggers (per-plan reviews,
        // fresh DoD verifier) that may have been skipped while the project was blocked. We skip
        // verifier completions because their effect (project→done, or counter bump + cap-block)
        // was applied at complete_work time; replaying them now under a dod_verified=undefined
        // row would incorrectly flip the project back to 'done'.
        const completions = await client.query<{
          id: number;
          project_id: number;
          plan_id: number | null;
          type: 'plan' | 'code' | 'review';
          is_dod_verifier: boolean;
        }>(
          `SELECT id, project_id, plan_id, type, is_dod_verifier
             FROM work_items
            WHERE project_id = $1 AND status = 'completed' AND is_dod_verifier = false
            ORDER BY completed_at ASC NULLS LAST, id ASC`,
          [id],
        );
        for (const row of completions.rows) {
          await advanceProjectAfterWorkCompletion(client, id, row);
        }

        await client.query('COMMIT');
        return ok({
          project: updProj.rows[0],
          cascade_unblocked_count: cascade.rowCount ?? 0,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  server.registerTool(
    'retry_project',
    {
      description:
        'Re-open a project that hit done but on inspection is not actually done. Sets status back to in_progress and retries the existing DoD verifier work item.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const proj = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM projects WHERE id=$1 FOR UPDATE`,
          [id],
        );
        if (proj.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        }
        const verifier = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM work_items
            WHERE project_id=$1 AND is_dod_verifier=true
            ORDER BY id DESC LIMIT 1
            FOR UPDATE`,
          [id],
        );
        if (verifier.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(
            new AppError('conflict', `project ${id} has no DoD verifier to retry`),
          );
        }
        const updProj = await client.query(
          `UPDATE projects SET status='in_progress', updated_at=now() WHERE id=$1 RETURNING *`,
          [id],
        );
        const updVerifier = await client.query(
          `UPDATE work_items
              SET status='pending',
                  claimed_at=NULL,
                  claimed_by=NULL,
                  claim_expires_at=NULL,
                  failure_reason=NULL,
                  next_retry_at=NULL,
                  updated_at=now()
            WHERE id=$1 RETURNING *`,
          [verifier.rows[0].id],
        );
        await client.query('COMMIT');
        return ok({ project: updProj.rows[0], verifier: updVerifier.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );
}

export interface CompletedWork {
  id: number;
  project_id: number | null;
  plan_id: number | null;
  type: 'plan' | 'code' | 'review';
  is_dod_verifier: boolean;
  dod_verified?: boolean;
}

export async function advanceProjectAfterWorkCompletion(
  client: PoolClient,
  projectId: number,
  completed: CompletedWork,
): Promise<void> {
  const proj = await client.query<{
    id: number;
    title: string;
    status: string;
    definition_of_done_md: string;
    app_id: number;
  }>(
    `SELECT id, title, status, definition_of_done_md, app_id FROM projects WHERE id=$1 FOR UPDATE`,
    [projectId],
  );
  if (proj.rowCount === 0) return;
  const status = proj.rows[0].status;
  if (status !== 'scoping' && status !== 'in_progress') return;

  if (completed.is_dod_verifier) {
    if (completed.dod_verified !== false) {
      await client.query(`UPDATE projects SET status='done', updated_at=now() WHERE id=$1`, [
        projectId,
      ]);
      return;
    }
    const cfg = await client.query<{ max_dod_fix_cycles: number }>(
      `SELECT max_dod_fix_cycles FROM runner_config WHERE id = 1`,
    );
    const cap = cfg.rows[0].max_dod_fix_cycles;
    const bumped = await client.query<{ dod_cycle_count: number }>(
      `UPDATE projects
          SET dod_cycle_count = dod_cycle_count + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING dod_cycle_count`,
      [projectId],
    );
    const newCount = bumped.rows[0].dod_cycle_count;
    if (newCount >= cap) {
      await client.query(
        `UPDATE projects
            SET status = 'blocked',
                failure_reason = $2,
                updated_at = now()
          WHERE id = $1`,
        [projectId, `DoD not verified after ${newCount} cycles`],
      );
    }
    return;
  }

  if (completed.plan_id !== null && completed.type === 'code') {
    const remaining = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE plan_id=$1 AND type='code' AND status <> 'completed'`,
      [completed.plan_id],
    );
    const reviewExists = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE plan_id=$1 AND type='review'`,
      [completed.plan_id],
    );
    if (remaining.rows[0].n === 0 && reviewExists.rows[0].n === 0) {
      const teamId = await resolveTeamDefault(client, proj.rows[0].app_id, 'review');
      await client.query(
        `INSERT INTO work_items(type, title, description_markdown, plan_id, project_id, team_id)
         VALUES ('review', $1, $2, $3, $4, $5)`,
        [
          `Review plan ${completed.plan_id} for project ${projectId}`,
          `Auto-enqueued review for plan ${completed.plan_id} under project ${projectId}.\n\n` +
            `All code work items for that plan are completed. Review the diff(s) and either ` +
            `approve, request changes, or comment per /sapling:work review semantics.`,
          completed.plan_id,
          projectId,
          teamId,
        ],
      );
    }
  }

  const remainingNonVerifier = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_items
       WHERE project_id=$1 AND is_dod_verifier=false AND status <> 'completed'`,
    [projectId],
  );
  const nonTerminalVerifier = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_items
       WHERE project_id=$1
         AND is_dod_verifier=true
         AND status IN ('pending','claimed','awaiting_input','blocked')`,
    [projectId],
  );
  if (remainingNonVerifier.rows[0].n === 0 && nonTerminalVerifier.rows[0].n === 0) {
    const teamId = await resolveTeamDefault(client, proj.rows[0].app_id, 'review');
    await client.query(
      `INSERT INTO work_items(type, title, description_markdown, project_id, is_dod_verifier, team_id)
       VALUES ('review', $1, $2, $3, true, $4)`,
      [
        `Verify Definition of Done for project ${projectId}: ${proj.rows[0].title}`,
        `All non-verifier work items are completed. Verify each DoD criterion against shipped reality (PRs, tests, code).\n\n` +
          `Definition of Done:\n\n${proj.rows[0].definition_of_done_md}\n\n` +
          `If the DoD is fully satisfied:\n` +
          `  → complete_work({ id: <this>, dod_verified: true })\n` +
          `  → project flips to 'done'.\n\n` +
          `If there are gaps:\n` +
          `  1. For EACH gap, call enqueue_work with: type='code', project_id=<this project>, plan_id=NULL, ` +
          `title=<short, imperative>, description_markdown=<what's missing, how to verify, which service>.\n` +
          `  2. Optionally attach a 'dod_gaps' artifact summarizing the round.\n` +
          `  3. complete_work({ id: <this>, dod_verified: false })\n` +
          `     → cycle counter bumps; a fresh verifier auto-arms once fixes complete, ` +
          `unless max_dod_fix_cycles is hit, in which case the project is auto-blocked.`,
        projectId,
        teamId,
      ],
    );
  }
}
