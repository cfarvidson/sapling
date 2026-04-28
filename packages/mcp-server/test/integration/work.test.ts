import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('work queue tools (basic CRUD)', () => {
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
    await db.pool.query('TRUNCATE work_items, plans, services, apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('enqueue_work stores a typed pending task', async () => {
    const item = await client.call('enqueue_work', {
      type: 'plan',
      title: 'Plan checkout v2',
      description_markdown: 'Goal: ...',
      priority: 5,
    });
    expect(item).toMatchObject({
      type: 'plan',
      status: 'pending',
      title: 'Plan checkout v2',
      priority: 5,
    });
  });

  it('get_work returns full record', async () => {
    const created = (await client.call('enqueue_work', {
      type: 'code',
      title: 'do thing',
      description_markdown: 'why',
    })) as { id: number };
    const fetched = await client.call('get_work', { id: created.id });
    expect(fetched).toMatchObject({ id: created.id, title: 'do thing', type: 'code' });
  });

  it('list_work supports status, type, service, plan filters', async () => {
    await client.call('enqueue_work', { type: 'plan', title: 'p', description_markdown: 'x' });
    await client.call('enqueue_work', { type: 'code', title: 'c', description_markdown: 'x' });

    const codeOnly = (await client.call('list_work', { type: 'code' })) as Array<unknown>;
    expect(codeOnly).toHaveLength(1);

    const allPending = (await client.call('list_work', { status: 'pending' })) as Array<unknown>;
    expect(allPending).toHaveLength(2);
  });

  it('enqueue_work with bad enum rejects with invalid_input', async () => {
    const raw = await client.callRaw('enqueue_work', {
      type: 'nope',
      title: 'x',
      description_markdown: 'x',
    });
    expect(raw.isError).toBe(true);
  });
});

describe('complete / fail / cancel work', () => {
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
      'TRUNCATE work_items, artifacts, plans, services, apps RESTART IDENTITY CASCADE',
    );
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  async function enqueueAndClaim() {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await client.call('claim_next_work', { claimed_by: 'tester' });
    return item;
  }

  it('complete_work marks completed, sets completed_at', async () => {
    const item = await enqueueAndClaim();
    const completed = (await client.call('complete_work', { id: item.id })) as {
      status: string;
      completed_at: string;
    };
    expect(completed.status).toBe('completed');
    expect(new Date(completed.completed_at).getTime()).toBeGreaterThan(0);
  });

  it('complete_work with summary creates an artifact and links it', async () => {
    const item = await enqueueAndClaim();
    const completed = (await client.call('complete_work', {
      id: item.id,
      summary_markdown: '# done\nstuff',
    })) as { id: number };
    const artifacts = (await client.call('list_artifacts', {
      work_item_id: completed.id,
    })) as Array<unknown>;
    expect(artifacts).toHaveLength(1);
  });

  it('fail_work sets status=failed and stores reason', async () => {
    const item = await enqueueAndClaim();
    const failed = (await client.call('fail_work', { id: item.id, reason: 'tests broke' })) as {
      status: string;
      failure_reason: string;
    };
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toBe('tests broke');
  });

  it('cancel_work sets status=cancelled', async () => {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    const cancelled = (await client.call('cancel_work', {
      id: item.id,
      reason: 'no longer needed',
    })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });
});
