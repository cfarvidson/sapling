import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerProducts(server: McpServer, db: Db): void {
  server.registerTool(
    'register_app',
    {
      description: 'Create an app (top-level product grouping for services).',
      inputSchema: { name: z.string().min(1), description: z.string().optional() },
    },
    async ({ name, description }) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO apps(name, description) VALUES ($1, $2) RETURNING *`,
          [name, description ?? null],
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

  // Service tools added in Task 10.
}
