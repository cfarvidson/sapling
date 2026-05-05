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
  // Suppress unused-arg lint until tools are filled in by subsequent tasks.
  void db;
  void ok;
  void mapPgError;

  for (const name of [
    'create_project',
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
        description: `Stub for ${name}; real implementation lands in subsequent tasks.`,
        inputSchema: { _stub: z.unknown().optional() },
      },
      async () => NotImplemented(),
    );
  }
}
