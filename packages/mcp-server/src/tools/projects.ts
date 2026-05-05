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

  // Stubs for the remaining seven tools — real implementations land in subsequent tasks.
  for (const name of [
    'get_project',
    'list_projects',
    'update_project',
    'cancel_project',
    'block_project',
    'unblock_project',
    'retry_project',
  ] as const) {
    server.registerTool(
      name,
      {
        description: `Stub for ${name}; real implementation lands in a subsequent task.`,
        inputSchema: { _stub: z.unknown().optional() },
      },
      async () => NotImplemented(),
    );
  }
}
