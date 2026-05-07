import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

const PlanStatus = z.enum(['draft', 'active', 'completed', 'archived']);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const PLAN_LIST_COLUMNS =
  'id, title, status, service_id, parent_plan_id, project_id, created_at, updated_at';

export function registerPlans(server: McpServer, db: Db): void {
  server.registerTool(
    'create_plan',
    {
      description: 'Store a new plan as markdown body plus structured fields.',
      inputSchema: {
        title: z.string().min(1),
        body_markdown: z.string(),
        service_id: z.number().int().positive().optional(),
        parent_plan_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
        status: PlanStatus.default('draft'),
      },
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO plans(title, body_markdown, service_id, parent_plan_id, project_id, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            input.title,
            input.body_markdown,
            input.service_id ?? null,
            input.parent_plan_id ?? null,
            input.project_id ?? null,
            input.status,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_plan',
    {
      description: 'Fetch a plan including the full body_markdown.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM plans WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `plan ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_plans',
    {
      description:
        'List plans (titles + structured fields, no body) optionally filtered by service, project, or status.',
      inputSchema: {
        service_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
        status: PlanStatus.optional(),
      },
    },
    async ({ service_id, project_id, status }) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (service_id !== undefined) {
        vals.push(service_id);
        conds.push(`service_id = $${vals.length}`);
      }
      if (project_id !== undefined) {
        vals.push(project_id);
        conds.push(`project_id = $${vals.length}`);
      }
      if (status !== undefined) {
        vals.push(status);
        conds.push(`status = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT ${PLAN_LIST_COLUMNS} FROM plans ${where} ORDER BY id ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  server.registerTool(
    'update_plan',
    {
      description: 'Patch any subset of plan fields.',
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        body_markdown: z.string().optional(),
        status: PlanStatus.optional(),
        service_id: z.number().int().positive().nullable().optional(),
        parent_plan_id: z.number().int().positive().nullable().optional(),
        project_id: z.number().int().positive().nullable().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(
        (k) => patch[k] !== undefined,
      );
      if (fields.length === 0) {
        return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
      }
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
          `UPDATE plans SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `plan ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}
