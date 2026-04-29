import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerHumanInput(server: McpServer, db: Db): void {
  server.registerTool(
    'request_human_input',
    {
      description:
        'Pause an in-flight work item to ask the human a question. Atomic: writes a pending_questions artifact and flips status to awaiting_input. claim_next_work skips awaiting_input items; provide_human_input flips them back to pending.',
      inputSchema: {
        work_id: z.number().int().positive(),
        questions_markdown: z.string().min(1),
      },
    },
    async ({ work_id, questions_markdown }) => {
      try {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const upd = await client.query<{ id: number; title: string; status: string }>(
            `UPDATE work_items
                SET status = 'awaiting_input',
                    claimed_at = NULL,
                    claimed_by = NULL,
                    claim_expires_at = NULL,
                    updated_at = now()
              WHERE id = $1
                AND status NOT IN ('completed','cancelled')
            RETURNING id, title, status`,
            [work_id],
          );
          if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            const exists = await db.query(`SELECT 1 FROM work_items WHERE id = $1`, [work_id]);
            if (exists.rowCount === 0) {
              return errorToToolResult(new AppError('not_found', `work ${work_id} not found`));
            }
            return errorToToolResult(
              new AppError(
                'conflict',
                `work ${work_id} is in a terminal state (completed/cancelled)`,
              ),
            );
          }
          const work = upd.rows[0];
          const artifact = await client.query(
            `INSERT INTO artifacts(kind, title, body_markdown, work_item_id)
             VALUES ('pending_questions', $1, $2, $3)
             RETURNING *`,
            [`Pending questions: ${work.title}`, questions_markdown, work_id],
          );
          await client.query('COMMIT');
          return ok({ work_item_id: work.id, status: work.status, artifact: artifact.rows[0] });
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
    'provide_human_input',
    {
      description:
        'Answer the latest pending_questions on an awaiting_input work item. Atomic: writes an answers artifact and flips status back to pending so the runner re-claims it.',
      inputSchema: {
        work_id: z.number().int().positive(),
        answers_markdown: z.string().min(1),
      },
    },
    async ({ work_id, answers_markdown }) => {
      try {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const upd = await client.query<{ id: number; title: string; status: string }>(
            `UPDATE work_items
                SET status = 'pending',
                    next_retry_at = NULL,
                    updated_at = now()
              WHERE id = $1 AND status = 'awaiting_input'
            RETURNING id, title, status`,
            [work_id],
          );
          if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            const exists = await db.query(`SELECT 1 FROM work_items WHERE id = $1`, [work_id]);
            if (exists.rowCount === 0) {
              return errorToToolResult(new AppError('not_found', `work ${work_id} not found`));
            }
            return errorToToolResult(
              new AppError('conflict', `work ${work_id} is not in 'awaiting_input' state`),
            );
          }
          const work = upd.rows[0];
          const artifact = await client.query(
            `INSERT INTO artifacts(kind, title, body_markdown, work_item_id)
             VALUES ('answers', $1, $2, $3)
             RETURNING *`,
            [`Answers: ${work.title}`, answers_markdown, work_id],
          );
          await client.query('COMMIT');
          return ok({ work_item_id: work.id, status: work.status, artifact: artifact.rows[0] });
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
}
