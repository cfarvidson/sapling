import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const NotImplemented = () =>
  errorToToolResult(new AppError('internal', 'project tool not yet implemented'));

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
      if (!input.definition_of_done_md.trim()) {
        return errorToToolResult(
          new AppError('invalid_input', 'definition_of_done_md must not be empty'),
        );
      }

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

        const fastPath = (input.service_ids?.length ?? 0) > 0;
        if (fastPath) {
          const services = await client.query<{ id: number; app_id: number; name: string }>(
            `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
            [input.service_ids],
          );
          if (services.rowCount !== input.service_ids!.length) {
            await client.query('ROLLBACK');
            return errorToToolResult(
              new AppError('not_found', 'one or more service_ids not found'),
            );
          }
          const wrong = services.rows.find((s) => s.app_id !== appId);
          if (wrong) {
            await client.query('ROLLBACK');
            return errorToToolResult(
              new AppError(
                'invalid_input',
                `service ${wrong.id} (${wrong.name}) does not belong to app ${input.app_name}`,
              ),
            );
          }
        }

        const initialStatus = fastPath ? 'in_progress' : 'scoping';
        const projInsert = await client.query(
          `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, linear_url, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            appId,
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
          await client.query('COMMIT');
          return ok({ project, scoping_work: scoping.rows[0] });
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
        await client.query('COMMIT');
        return ok({ project, plan_work_items: planWorkItems });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
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
                p.linear_url, p.created_at, p.updated_at
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
        'Block a project on an external dependency from scoping/in_progress. Does not cascade to children — they continue. Reason is required.',
      inputSchema: {
        id: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE projects
            SET status='blocked',
                failure_reason=$2,
                updated_at=now()
          WHERE id=$1 AND status IN ('scoping','in_progress')
         RETURNING *`,
        [id, reason],
      );
      if (rows.length === 0) {
        const exists = await db.query(`SELECT id FROM projects WHERE id=$1`, [id]);
        if (exists.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        return errorToToolResult(new AppError('conflict', `project ${id} is in a terminal state`));
      }
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'unblock_project',
    {
      description:
        'Unblock a project. Recomputes target state from children: scoping if a scoping plan-type work item is still pending/claimed, else in_progress. Replays auto-enqueue triggers that fired while blocked.',
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
        const upd = await client.query(
          `UPDATE projects
              SET status=$2, failure_reason=NULL, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [id, target],
        );

        // Replay missed triggers — implementation lands in Task 11.
        // (Intentional placeholder; the lifecycle tests in Task 12 will exercise it.)

        await client.query('COMMIT');
        return ok(upd.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  // Stub for retry_project — real implementation lands in Task 10.
  server.registerTool(
    'retry_project',
    {
      description: `Stub for retry_project; real implementation lands in a subsequent task.`,
      inputSchema: { _stub: z.unknown().optional() },
    },
    async () => NotImplemented(),
  );
}
