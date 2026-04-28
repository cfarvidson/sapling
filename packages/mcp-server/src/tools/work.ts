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
                SET status = 'completed', completed_at = now(), updated_at = now()
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
        `UPDATE work_items SET status='cancelled', failure_reason=$2, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, reason ?? null],
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );
}

const WorkTypeArr = z.array(WorkType).min(1);

export function registerWorkClaim(server: McpServer, db: Db): void {
  server.registerTool(
    'claim_next_work',
    {
      description: 'Atomically claim the next pending work item. Returns null if none.',
      inputSchema: {
        claimed_by: z.string().min(1),
        types: WorkTypeArr.optional(),
        service_id: z.number().int().positive().optional(),
      },
    },
    async ({ claimed_by, types, service_id }) => {
      const { rows } = await db.query(
        `WITH next AS (
           SELECT id FROM work_items
            WHERE status = 'pending'
              AND ($1::work_type[] IS NULL OR type = ANY($1))
              AND ($2::int IS NULL OR service_id = $2)
            ORDER BY priority DESC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE work_items w
            SET status = 'claimed', claimed_at = now(), claimed_by = $3, updated_at = now()
           FROM next
          WHERE w.id = next.id
         RETURNING w.*`,
        [types ?? null, service_id ?? null, claimed_by],
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows[0] ?? null) }] };
    },
  );
}
