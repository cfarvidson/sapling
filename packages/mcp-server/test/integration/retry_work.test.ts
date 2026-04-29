import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

interface WorkRow {
  id: number;
  status: string;
  attempt_count: number;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  next_retry_at: string | null;
  failure_reason: string | null;
}

describe('retry_work', () => {
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

  async function enqueue(): Promise<{ id: number }> {
    return (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
  }

  async function fetchRow(id: number): Promise<WorkRow> {
    const { rows } = await db.pool.query<WorkRow>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    return rows[0];
  }

  it('flips a failed work item to pending and clears claim + failure fields (no after_ms)', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'agent-a' });
    await client.call('fail_work', { id: item.id, reason: 'boom' });

    const before = await fetchRow(item.id);
    expect(before.status).toBe('failed');
    expect(before.attempt_count).toBe(1);
    expect(before.failure_reason).toBe('boom');

    const updated = (await client.call('retry_work', { id: item.id })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.next_retry_at).toBeNull();
    expect(updated.claimed_at).toBeNull();
    expect(updated.claimed_by).toBeNull();
    expect(updated.claim_expires_at).toBeNull();
    expect(updated.failure_reason).toBeNull();
    // attempt_count is preserved — explicit retries are clean retries.
    expect(updated.attempt_count).toBe(1);
  });

  it('schedules next_retry_at in the future when after_ms > 0', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'agent-a' });
    await client.call('fail_work', { id: item.id, reason: 'transient' });

    const t0 = Date.now();
    const updated = (await client.call('retry_work', {
      id: item.id,
      after_ms: 60_000,
    })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.next_retry_at).not.toBeNull();
    const ts = new Date(updated.next_retry_at as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(t0 + 60_000 - 1_000);
    expect(ts).toBeLessThanOrEqual(t0 + 60_000 + 5_000);
  });

  it('treats after_ms = 0 as no delay (next_retry_at = NULL)', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'agent-a' });
    await client.call('fail_work', { id: item.id, reason: 'x' });

    const updated = (await client.call('retry_work', {
      id: item.id,
      after_ms: 0,
    })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.next_retry_at).toBeNull();
  });

  it('flips a blocked work item back to pending', async () => {
    const item = await enqueue();
    await client.call('block_work', { id: item.id, reason: 'waiting' });
    expect((await fetchRow(item.id)).status).toBe('blocked');

    const updated = (await client.call('retry_work', { id: item.id })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.failure_reason).toBeNull();
  });

  it('flips an awaiting_input work item back to pending (operator override)', async () => {
    const item = await enqueue();
    await client.call('request_human_input', {
      work_id: item.id,
      questions_markdown: '1. Q?',
    });
    expect((await fetchRow(item.id)).status).toBe('awaiting_input');

    const updated = (await client.call('retry_work', { id: item.id })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.failure_reason).toBeNull();
  });

  it('flips a claimed (operator-overridden) work item back to pending', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'stuck-agent' });
    expect((await fetchRow(item.id)).status).toBe('claimed');

    const updated = (await client.call('retry_work', { id: item.id })) as WorkRow;
    expect(updated.status).toBe('pending');
    expect(updated.claimed_at).toBeNull();
    expect(updated.claimed_by).toBeNull();
    expect(updated.claim_expires_at).toBeNull();
  });

  it('returns conflict 409 for a completed work item', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'agent-a' });
    await client.call('complete_work', { id: item.id });

    const result = await client.callRaw('retry_work', { id: item.id });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(payload.error.code).toBe('conflict');
    expect((await fetchRow(item.id)).status).toBe('completed');
  });

  it('returns conflict 409 for a cancelled work item', async () => {
    const item = await enqueue();
    await client.call('cancel_work', { id: item.id, reason: 'no longer relevant' });

    const result = await client.callRaw('retry_work', { id: item.id });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(payload.error.code).toBe('conflict');
  });

  it('returns conflict 409 for an unknown id', async () => {
    const result = await client.callRaw('retry_work', { id: 9999 });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(payload.error.code).toBe('conflict');
  });

  it('claim_next_work honours next_retry_at set by retry_work', async () => {
    const item = await enqueue();
    await client.call('claim_next_work', { claimed_by: 'agent-a' });
    await client.call('fail_work', { id: item.id, reason: 'transient' });

    await client.call('retry_work', { id: item.id, after_ms: 60_000 });
    const skipped = (await client.call('claim_next_work', {
      claimed_by: 'agent-b',
    })) as WorkRow | null;
    expect(skipped).toBeNull();

    // Move next_retry_at into the past, then claim_next_work should succeed.
    await db.pool.query(
      `UPDATE work_items SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [item.id],
    );
    const claimed = (await client.call('claim_next_work', { claimed_by: 'agent-b' })) as WorkRow;
    expect(claimed.id).toBe(item.id);
    expect(claimed.status).toBe('claimed');
  });
});
