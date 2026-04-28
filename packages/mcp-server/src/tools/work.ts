import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

const WorkType = z.enum(['plan', 'code', 'review']);
const WorkStatus = z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled']);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerWork(server: McpServer, db: Db): void {
  server.registerTool(
    'enqueue_work',
    {
      description: 'Add a typed task to the queue (plan / code / review).',
      inputSchema: {
        type: WorkType,
        title: z.string().min(1),
        description_markdown: z.string(),
        priority: z.number().int().default(0),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        branch: z.string().optional(),
        pr_url: z.string().url().optional(),
      },
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO work_items
             (type, title, description_markdown, priority, service_id, plan_id, branch, pr_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            input.type,
            input.title,
            input.description_markdown,
            input.priority,
            input.service_id ?? null,
            input.plan_id ?? null,
            input.branch ?? null,
            input.pr_url ?? null,
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
      description: 'List work items with optional filters.',
      inputSchema: {
        status: WorkStatus.optional(),
        type: WorkType.optional(),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
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
        `SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  // claim_next_work / complete_work / fail_work / cancel_work added in Tasks 13-14.
}
