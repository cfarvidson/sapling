import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../../mcp-server/src/migrate.js';
import { registerAllTools } from '../../../mcp-server/src/tools/register.js';
import { wrapMcpClient, type McpClient } from 'sapling-mcp-client';
import type pg from 'pg';

export interface InProcessMcp {
  mcp: McpClient;
  server: McpServer;
  client: Client;
  close: () => Promise<void>;
}

export async function startInProcessMcp(pool: pg.Pool): Promise<InProcessMcp> {
  await runMigrations(pool);
  const server = new McpServer({ name: 'sapling-runner-test', version: '0.0.0' });
  registerAllTools(server, pool);
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'runner-test', version: '0.0.0' });
  await client.connect(clientT);
  const mcp = wrapMcpClient(client);
  return {
    mcp,
    server,
    client,
    close: async () => {
      await client.close();
    },
  };
}
