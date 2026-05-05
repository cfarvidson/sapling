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

        // Fast path implemented in Task 4.
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError('internal', 'fast path not yet implemented (Task 4)'),
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  // Stubs for the remaining eight tools — same shape as Task 2.
  for (const name of [
    'complete_scoping',
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
