import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const PositiveInt = z.number().int().positive();

export function registerRunnerConfig(server: McpServer, db: Db): void {
  server.registerTool(
    'get_runner_config',
    {
      description: 'Fetch the singleton runner_config row.',
      inputSchema: {},
    },
    async () => {
      const { rows } = await db.query(`SELECT * FROM runner_config WHERE id = 1`);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', 'runner_config row missing'));
      const row = { ...rows[0] };
      if (row.github_token != null) row.github_token = '***';
      return ok(row);
    },
  );

  server.registerTool(
    'update_runner_config',
    {
      description:
        'Patch the singleton runner_config row. Only specified fields are updated; integer fields must be > 0. ntfy_url accepts null to disable notifications.',
      inputSchema: {
        agent_command: z.string().min(1).optional(),
        max_concurrent: PositiveInt.optional(),
        poll_interval_ms: PositiveInt.optional(),
        claim_ttl_ms: PositiveInt.optional(),
        max_claim_attempts: PositiveInt.optional(),
        ntfy_url: z.string().min(1).nullable().optional(),
        awaiting_input_nag_age_ms: PositiveInt.optional(),
        awaiting_input_nag_repeat_ms: PositiveInt.optional(),
        github_token: z.string().min(1).nullable().optional(),
        github_default_visibility: z.enum(['all', 'public', 'private']).optional(),
      },
    },
    async (input) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const fields: Array<keyof typeof input> = [
        'agent_command',
        'max_concurrent',
        'poll_interval_ms',
        'claim_ttl_ms',
        'max_claim_attempts',
        'ntfy_url',
        'awaiting_input_nag_age_ms',
        'awaiting_input_nag_repeat_ms',
        'github_token',
        'github_default_visibility',
      ];
      for (const k of fields) {
        const v = input[k];
        if (v === undefined) continue;
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
      if (sets.length === 0) {
        return errorToToolResult(
          new AppError('invalid_input', 'update_runner_config requires at least one field'),
        );
      }
      sets.push(`updated_at = now()`);
      try {
        const { rows } = await db.query(
          `UPDATE runner_config SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
          vals,
        );
        const row = { ...rows[0] };
        if (row.github_token != null) row.github_token = '***';
        return ok(row);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}
