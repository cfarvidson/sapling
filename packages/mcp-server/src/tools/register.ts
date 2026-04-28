import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { registerProducts } from './products.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
}
