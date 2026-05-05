import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects tools — registration', () => {
  let db: TestDb;
  let client: TestClient;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await client?.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('exposes the nine project tools', async () => {
    // calling an unknown tool throws; calling a known tool with bad args returns isError.
    const expected = [
      'create_project',
      'complete_scoping',
      'get_project',
      'list_projects',
      'update_project',
      'cancel_project',
      'block_project',
      'unblock_project',
      'retry_project',
    ];
    for (const name of expected) {
      const raw = await client.callRaw(name, {});
      // Each tool is registered (no MethodNotFound). Either it accepts {} (returns isError)
      // or zod rejects it (returns isError). We only assert it doesn't blow up as missing.
      expect(raw).toBeDefined();
    }
  });
});
