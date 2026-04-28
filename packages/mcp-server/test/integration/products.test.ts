import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('apps tools', () => {
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

  it('register_app creates an app and returns it', async () => {
    const app = await client.call('register_app', { name: 'checkout', description: 'cart + pay' });
    expect(app).toMatchObject({ id: 1, name: 'checkout', description: 'cart + pay' });
  });

  it('list_apps returns all apps in insertion order', async () => {
    await client.call('register_app', { name: 'a' });
    await client.call('register_app', { name: 'b' });
    const apps = await client.call('list_apps', {});
    expect(apps).toMatchObject([{ name: 'a' }, { name: 'b' }]);
  });

  it('register_app rejects duplicate names with conflict error', async () => {
    await client.call('register_app', { name: 'dup' });
    const raw = await client.callRaw('register_app', { name: 'dup' });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('conflict');
  });
});
