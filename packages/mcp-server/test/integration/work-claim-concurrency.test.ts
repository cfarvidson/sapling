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
    await db.pool.query(
      `UPDATE runner_config
          SET agent_command = DEFAULT,
              max_concurrent = DEFAULT,
              poll_interval_ms = DEFAULT,
              claim_ttl_ms = DEFAULT,
              max_claim_attempts = DEFAULT,
              updated_at = now()
        WHERE id = 1`,
    );
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

  it('sets claim_expires_at near now() + claim_ttl_ms and increments attempt_count', async () => {
    await client.call('update_runner_config', { claim_ttl_ms: 60_000 });
    await client.call('enqueue_work', { type: 'code', title: 't', description_markdown: 'x' });

    const before = Date.now();
    const claimed = (await client.call('claim_next_work', { claimed_by: 'a' })) as {
      attempt_count: number;
      claim_expires_at: string;
    };
    const expires = new Date(claimed.claim_expires_at).getTime();
    expect(claimed.attempt_count).toBe(1);
    expect(expires - before).toBeGreaterThanOrEqual(55_000);
    expect(expires - before).toBeLessThan(120_000);
  });

  it('skips items whose next_retry_at is in the future and picks them once it passes', async () => {
    const future = (await client.call('enqueue_work', {
      type: 'code',
      title: 'future',
      description_markdown: 'x',
    })) as { id: number };
    const ready = (await client.call('enqueue_work', {
      type: 'code',
      title: 'ready',
      description_markdown: 'x',
    })) as { id: number };

    await db.pool.query(
      `UPDATE work_items SET next_retry_at = now() + interval '1 hour' WHERE id = $1`,
      [future.id],
    );

    const first = (await client.call('claim_next_work', { claimed_by: 'a' })) as {
      id: number;
      title: string;
    };
    expect(first.id).toBe(ready.id);

    const second = await client.call('claim_next_work', { claimed_by: 'a' });
    expect(second).toBeNull();

    await db.pool.query(
      `UPDATE work_items SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [future.id],
    );
    const third = (await client.call('claim_next_work', { claimed_by: 'a' })) as { id: number };
    expect(third.id).toBe(future.id);
  });

  it('skips items where attempt_count has reached max_claim_attempts', async () => {
    await client.call('update_runner_config', { max_claim_attempts: 2 });
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 'exhausted',
      description_markdown: 'x',
    })) as { id: number };

    await db.pool.query(`UPDATE work_items SET attempt_count = 2 WHERE id = $1`, [item.id]);

    const result = await client.call('claim_next_work', { claimed_by: 'a' });
    expect(result).toBeNull();
  });

  it('complete_work clears claim_expires_at and next_retry_at', async () => {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await db.pool.query(
      `UPDATE work_items SET next_retry_at = now() - interval '1 minute' WHERE id = $1`,
      [item.id],
    );
    await client.call('claim_next_work', { claimed_by: 'a' });

    const claimed = (await client.call('get_work', { id: item.id })) as {
      claim_expires_at: string | null;
    };
    expect(claimed.claim_expires_at).not.toBeNull();

    const completed = (await client.call('complete_work', { id: item.id })) as {
      claim_expires_at: string | null;
      next_retry_at: string | null;
    };
    expect(completed.claim_expires_at).toBeNull();
    expect(completed.next_retry_at).toBeNull();
  });
});
