import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

interface ReapedRow {
  id: number;
  status: 'pending' | 'failed';
  attempt_count: number;
  prior_claimed_by: string | null;
}

describe('reap_stuck_claims', () => {
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

  async function enqueueAndClaim(claimedBy = 'agent-a'): Promise<{ id: number }> {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await client.call('claim_next_work', { claimed_by: claimedBy });
    return item;
  }

  function expireRow(id: number): Promise<unknown> {
    return db.pool.query(
      `UPDATE work_items SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
  }

  it('returns [] when nothing is claimed', async () => {
    const reaped = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(reaped).toEqual([]);
  });

  it('returns [] when claims have not expired', async () => {
    await enqueueAndClaim();
    const reaped = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(reaped).toEqual([]);

    const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM work_items`);
    expect(rows.map((r) => r.status)).toEqual(['claimed']);
  });

  it('transitions stuck claim under max attempts back to pending and clears claim fields', async () => {
    const item = await enqueueAndClaim('runaway-agent');
    await expireRow(item.id);

    const reaped = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({
      id: item.id,
      status: 'pending',
      attempt_count: 1,
      prior_claimed_by: 'runaway-agent',
    });

    const { rows } = await db.pool.query<{
      status: string;
      claimed_by: string | null;
      claim_expires_at: string | null;
      failure_reason: string | null;
    }>(
      `SELECT status, claimed_by, claim_expires_at, failure_reason FROM work_items WHERE id = $1`,
      [item.id],
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].claimed_by).toBeNull();
    expect(rows[0].claim_expires_at).toBeNull();
    expect(rows[0].failure_reason).toBeNull();
  });

  it('transitions stuck claim at max attempts to failed with a named reason', async () => {
    await client.call('update_runner_config', { max_claim_attempts: 1 });

    const item = await enqueueAndClaim('crashy-agent');
    await expireRow(item.id);

    const reaped = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({
      id: item.id,
      status: 'failed',
      attempt_count: 1,
      prior_claimed_by: 'crashy-agent',
    });

    const { rows } = await db.pool.query<{
      status: string;
      claimed_by: string | null;
      claim_expires_at: string | null;
      failure_reason: string | null;
    }>(
      `SELECT status, claimed_by, claim_expires_at, failure_reason FROM work_items WHERE id = $1`,
      [item.id],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].claimed_by).toBeNull();
    expect(rows[0].claim_expires_at).toBeNull();
    expect(rows[0].failure_reason).toContain('1 attempts');
    expect(rows[0].failure_reason).toContain('crashy-agent');
  });

  it('honours the optional now parameter', async () => {
    const item = await enqueueAndClaim();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const reaped = (await client.call('reap_stuck_claims', { now: future })) as ReapedRow[];
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({ id: item.id, status: 'pending' });
  });

  it('is idempotent — second call after a sweep returns []', async () => {
    const item = await enqueueAndClaim();
    await expireRow(item.id);

    const first = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(first).toHaveLength(1);

    const second = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(second).toEqual([]);
  });

  it('reaps multiple stuck claims in one call and returns them sorted by id', async () => {
    const a = await enqueueAndClaim('agent-a');
    const b = await enqueueAndClaim('agent-b');
    await expireRow(a.id);
    await expireRow(b.id);

    const reaped = (await client.call('reap_stuck_claims', {})) as ReapedRow[];
    expect(reaped.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(reaped.every((r) => r.status === 'pending')).toBe(true);
  });
});
