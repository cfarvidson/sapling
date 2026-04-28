import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { registerPlans } from './plans.js';
import { registerProducts, registerServiceTools } from './products.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
  registerServiceTools(server, db);
  registerPlans(server, db);
}
