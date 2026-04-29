import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { registerArtifacts } from './artifacts.js';
import { registerHumanInput } from './human_input.js';
import { registerPlans } from './plans.js';
import { registerProducts, registerServiceTools } from './products.js';
import { registerRunnerConfig } from './runner_config.js';
import { registerWork, registerWorkClaim, registerWorkLifecycle } from './work.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
  registerServiceTools(server, db);
  registerPlans(server, db);
  registerWork(server, db);
  registerWorkClaim(server, db);
  registerWorkLifecycle(server, db);
  registerArtifacts(server, db);
  registerRunnerConfig(server, db);
  registerHumanInput(server, db);
}
