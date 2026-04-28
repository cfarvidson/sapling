import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerProducts(server: McpServer, db: Db): void {
  server.registerTool(
    'register_app',
    {
      description: 'Create an app (top-level product grouping for services).',
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        conventions: z.string().optional(),
      },
    },
    async ({ name, description, conventions }) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO apps(name, description, conventions) VALUES ($1, $2, $3) RETURNING *`,
          [name, description ?? null, conventions ?? null],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'list_apps',
    {
      description: 'List all apps.',
      inputSchema: {},
    },
    async () => {
      const { rows } = await db.query(`SELECT * FROM apps ORDER BY id ASC`);
      return ok(rows);
    },
  );

  server.registerTool(
    'get_app',
    {
      description: 'Fetch an app by id or name.',
      inputSchema: z
        .object({
          id: z.number().int().positive().optional(),
          name: z.string().optional(),
        })
        .refine((v) => v.id !== undefined || v.name !== undefined, {
          message: 'must provide id or name',
        }),
    },
    async (input) => {
      const { rows } =
        input.id !== undefined
          ? await db.query(`SELECT * FROM apps WHERE id = $1`, [input.id])
          : await db.query(`SELECT * FROM apps WHERE name = $1`, [input.name]);
      if (rows.length === 0) return errorToToolResult(new AppError('not_found', 'app not found'));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'update_app',
    {
      description: 'Patch any subset of app fields by id.',
      inputSchema: {
        id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        conventions: z.string().nullable().optional(),
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
          `UPDATE apps SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `app ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}

const ServiceLookup = z
  .object({
    id: z.number().int().positive().optional(),
    app_name: z.string().optional(),
    name: z.string().optional(),
  })
  .refine((v) => v.id !== undefined || (v.app_name !== undefined && v.name !== undefined), {
    message: 'must provide id, or both app_name and name',
  });

export function registerServiceTools(server: McpServer, db: Db): void {
  server.registerTool(
    'register_service',
    {
      description: 'Create a service under an app.',
      inputSchema: {
        app_name: z.string().min(1),
        name: z.string().min(1),
        repo_url: z.string().url().optional(),
        description: z.string().optional(),
        tech_stack: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        conventions: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const app = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          input.app_name,
        ]);
        if (app.rowCount === 0) {
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        }
        const { rows } = await db.query(
          `INSERT INTO services(app_id, name, repo_url, description, tech_stack, depends_on, conventions)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            app.rows[0].id,
            input.name,
            input.repo_url ?? null,
            input.description ?? null,
            input.tech_stack ?? [],
            input.depends_on ?? [],
            input.conventions ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'list_services',
    {
      description: 'List services, optionally filtered to one app.',
      inputSchema: { app_name: z.string().optional() },
    },
    async ({ app_name }) => {
      if (app_name) {
        const { rows } = await db.query(
          `SELECT s.* FROM services s JOIN apps a ON a.id = s.app_id
           WHERE a.name = $1 ORDER BY s.id ASC`,
          [app_name],
        );
        return ok(rows);
      }
      const { rows } = await db.query(`SELECT * FROM services ORDER BY id ASC`);
      return ok(rows);
    },
  );

  server.registerTool(
    'get_service',
    {
      description: 'Fetch a service by id, or by (app_name, name).',
      inputSchema: ServiceLookup,
    },
    async (input) => {
      let row: Record<string, unknown> | undefined;
      if (input.id !== undefined) {
        const { rows } = await db.query(`SELECT * FROM services WHERE id = $1`, [input.id]);
        row = rows[0];
      } else {
        const { rows } = await db.query(
          `SELECT s.* FROM services s JOIN apps a ON a.id = s.app_id
           WHERE a.name = $1 AND s.name = $2`,
          [input.app_name, input.name],
        );
        row = rows[0];
      }
      if (!row) return errorToToolResult(new AppError('not_found', 'service not found'));
      return ok(row);
    },
  );

  server.registerTool(
    'update_service',
    {
      description: 'Patch any subset of service fields by id.',
      inputSchema: {
        id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        repo_url: z.string().url().nullable().optional(),
        description: z.string().nullable().optional(),
        tech_stack: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        conventions: z.string().nullable().optional(),
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
          `UPDATE services SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `service ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}
