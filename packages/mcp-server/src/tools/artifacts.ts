import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const ARTIFACT_LIST_COLUMNS = 'id, kind, title, work_item_id, plan_id, service_id, created_at';

export function registerArtifacts(server: McpServer, db: Db): void {
  server.registerTool(
    'attach_artifact',
    {
      description: 'Store a markdown artifact, optionally linked to a work item, plan, or service.',
      inputSchema: {
        kind: z.string().min(1),
        title: z.string().min(1),
        body_markdown: z.string(),
        work_item_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        service_id: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO artifacts(kind, title, body_markdown, work_item_id, plan_id, service_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            input.kind,
            input.title,
            input.body_markdown,
            input.work_item_id ?? null,
            input.plan_id ?? null,
            input.service_id ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description: 'Fetch an artifact including the body.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM artifacts WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `artifact ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      description: 'List artifacts (titles only, no body) with optional filters.',
      inputSchema: {
        work_item_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        service_id: z.number().int().positive().optional(),
        kind: z.string().optional(),
      },
    },
    async (filters) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(filters)) {
        if (v === undefined) continue;
        vals.push(v);
        conds.push(`${k} = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT ${ARTIFACT_LIST_COLUMNS} FROM artifacts ${where} ORDER BY id ASC`,
        vals,
      );
      return ok(rows);
    },
  );
}
