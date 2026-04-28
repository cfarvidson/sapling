import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('services tools', () => {
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
    await client.call('register_app', { name: 'checkout' });
  });

  it('register_service attaches a service under an app', async () => {
    const svc = await client.call('register_service', {
      app_name: 'checkout',
      name: 'checkout-api',
      repo_url: 'https://github.com/x/checkout-api',
      tech_stack: ['typescript', 'postgres'],
      depends_on: ['auth'],
      conventions: 'see CLAUDE.md in repo',
    });
    expect(svc).toMatchObject({
      name: 'checkout-api',
      tech_stack: ['typescript', 'postgres'],
      depends_on: ['auth'],
    });
  });

  it('list_services returns services optionally filtered by app', async () => {
    await client.call('register_service', { app_name: 'checkout', name: 'api' });
    await client.call('register_service', { app_name: 'checkout', name: 'web' });
    await client.call('register_app', { name: 'orders' });
    await client.call('register_service', { app_name: 'orders', name: 'api' });
    const all = (await client.call('list_services', {})) as unknown[];
    expect(all).toHaveLength(3);
    const checkout = (await client.call('list_services', { app_name: 'checkout' })) as unknown[];
    expect(checkout).toHaveLength(2);
  });

  it('get_service accepts id or {app, name}', async () => {
    const created = (await client.call('register_service', {
      app_name: 'checkout',
      name: 'api',
    })) as { id: number };
    const byId = await client.call('get_service', { id: created.id });
    expect(byId).toMatchObject({ name: 'api' });
    const byName = await client.call('get_service', { app_name: 'checkout', name: 'api' });
    expect(byName).toMatchObject({ id: created.id });
  });

  it('get_service returns not_found error for unknown id', async () => {
    const raw = await client.callRaw('get_service', { id: 9999 });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });

  it('update_service patches provided fields and leaves others alone', async () => {
    const created = (await client.call('register_service', {
      app_name: 'checkout',
      name: 'api',
      tech_stack: ['typescript'],
    })) as { id: number };
    const updated = await client.call('update_service', {
      id: created.id,
      description: 'now with desc',
      tech_stack: ['typescript', 'pg'],
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'api',
      description: 'now with desc',
      tech_stack: ['typescript', 'pg'],
    });
  });
});

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
