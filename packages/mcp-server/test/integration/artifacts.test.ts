import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('artifacts tools', () => {
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
    await db.pool.query(
      'TRUNCATE artifacts, work_items, plans, services, apps RESTART IDENTITY CASCADE',
    );
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('attach_artifact stores body and links to work item', async () => {
    const w = (await client.call('enqueue_work', {
      type: 'review',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    const a = (await client.call('attach_artifact', {
      kind: 'review_notes',
      title: 'review',
      body_markdown: '## observations',
      work_item_id: w.id,
    })) as { id: number; work_item_id: number };
    expect(a.work_item_id).toBe(w.id);
  });

  it('get_artifact returns full body', async () => {
    const a = (await client.call('attach_artifact', {
      kind: 'snippet',
      title: 'x',
      body_markdown: 'long content',
    })) as { id: number };
    const fetched = (await client.call('get_artifact', { id: a.id })) as { body_markdown: string };
    expect(fetched.body_markdown).toBe('long content');
  });

  it('list_artifacts omits body and supports filters', async () => {
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await client.call('attach_artifact', {
      kind: 'note',
      title: 'a',
      body_markdown: 'x',
      work_item_id: w.id,
    });
    await client.call('attach_artifact', { kind: 'note', title: 'b', body_markdown: 'x' });
    const linked = (await client.call('list_artifacts', { work_item_id: w.id })) as Array<{
      body_markdown?: string;
    }>;
    expect(linked).toHaveLength(1);
    expect(linked[0].body_markdown).toBeUndefined();
  });

  it('attach_artifact with bad work_item_id returns not_found', async () => {
    const raw = await client.callRaw('attach_artifact', {
      kind: 'note',
      title: 'x',
      body_markdown: 'x',
      work_item_id: 9999,
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });
});
