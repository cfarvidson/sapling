import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('plans tools', () => {
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
    await db.pool.query('TRUNCATE plans, services, apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('create_plan stores title, body, default status=draft', async () => {
    const plan = await client.call('create_plan', {
      title: 'Add OAuth',
      body_markdown: '# Goal\nAdd OAuth',
    });
    expect(plan).toMatchObject({ id: 1, title: 'Add OAuth', status: 'draft' });
  });

  it('get_plan returns the full body', async () => {
    const created = (await client.call('create_plan', {
      title: 'A',
      body_markdown: 'long body here',
    })) as { id: number };
    const fetched = (await client.call('get_plan', { id: created.id })) as {
      body_markdown: string;
    };
    expect(fetched.body_markdown).toBe('long body here');
  });

  it('list_plans omits body and supports status filter', async () => {
    const a = (await client.call('create_plan', { title: 'a', body_markdown: 'x' })) as {
      id: number;
    };
    await client.call('create_plan', { title: 'b', body_markdown: 'x' });
    await client.call('update_plan', { id: a.id, status: 'completed' });

    const all = (await client.call('list_plans', {})) as Array<{
      id: number;
      body_markdown?: string;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0].body_markdown).toBeUndefined();

    const done = (await client.call('list_plans', { status: 'completed' })) as Array<unknown>;
    expect(done).toHaveLength(1);
  });

  it('update_plan patches title and body', async () => {
    const created = (await client.call('create_plan', { title: 'old', body_markdown: 'old' })) as {
      id: number;
    };
    const updated = await client.call('update_plan', {
      id: created.id,
      title: 'new',
      body_markdown: 'new',
    });
    expect(updated).toMatchObject({ title: 'new', body_markdown: 'new' });
  });

  it('create_plan with non-existent service_id returns not_found', async () => {
    const raw = await client.callRaw('create_plan', {
      title: 'x',
      body_markdown: 'x',
      service_id: 9999,
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });
});
