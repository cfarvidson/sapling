import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('claim_next_work — concurrency', () => {
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

  it('returns null when queue is empty', async () => {
    const result = await client.call('claim_next_work', { claimed_by: 'a' });
    expect(result).toBeNull();
  });

  it('returns highest-priority then oldest first', async () => {
    await client.call('enqueue_work', {
      type: 'code',
      title: 'old low',
      description_markdown: 'x',
      priority: 0,
    });
    await client.call('enqueue_work', {
      type: 'code',
      title: 'high',
      description_markdown: 'x',
      priority: 5,
    });

    const first = (await client.call('claim_next_work', { claimed_by: 'a' })) as { title: string };
    expect(first.title).toBe('high');
    const second = (await client.call('claim_next_work', { claimed_by: 'a' })) as { title: string };
    expect(second.title).toBe('old low');
  });

  it('two concurrent claims for one item: exactly one wins, other gets null', async () => {
    await client.call('enqueue_work', { type: 'code', title: 'only', description_markdown: 'x' });

    const [a, b] = await Promise.all([
      client.call('claim_next_work', { claimed_by: 'agent-a' }),
      client.call('claim_next_work', { claimed_by: 'agent-b' }),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    const losers = [a, b].filter((x) => x === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('respects type filter', async () => {
    await client.call('enqueue_work', { type: 'plan', title: 'p', description_markdown: 'x' });
    await client.call('enqueue_work', { type: 'code', title: 'c', description_markdown: 'x' });

    const codeOnly = (await client.call('claim_next_work', {
      claimed_by: 'a',
      types: ['code'],
    })) as { title: string };
    expect(codeOnly.title).toBe('c');
  });
});
