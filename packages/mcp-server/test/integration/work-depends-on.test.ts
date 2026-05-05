import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

type WorkRow = {
  id: number;
  status: string;
  title: string;
  depends_on_work_id: number | null;
};

describe('depends_on_work_id', () => {
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

  async function enqueue(title: string, extra: Record<string, unknown> = {}): Promise<WorkRow> {
    return (await client.call('enqueue_work', {
      type: 'code',
      title,
      description_markdown: 'x',
      ...extra,
    })) as WorkRow;
  }

  it('enqueue_work persists depends_on_work_id', async () => {
    const upstream = await enqueue('upstream');
    const dependent = await enqueue('dependent', { depends_on_work_id: upstream.id });
    expect(dependent.depends_on_work_id).toBe(upstream.id);
  });

  it('enqueue_work rejects unknown depends_on_work_id with not_found', async () => {
    const raw = await client.callRaw('enqueue_work', {
      type: 'code',
      title: 'orphan',
      description_markdown: 'x',
      depends_on_work_id: 9999,
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain('not_found');
  });

  it('enqueue_work rejects cross-app dependency with invalid_input', async () => {
    const a1 = (await client.call('register_app', { name: 'app-a' })) as { id: number };
    const a2 = (await client.call('register_app', { name: 'app-b' })) as { id: number };
    const s1 = (await client.call('register_service', {
      app_name: 'app-a',
      name: 's1',
    })) as { id: number };
    const s2 = (await client.call('register_service', {
      app_name: 'app-b',
      name: 's2',
    })) as { id: number };

    const upstream = await enqueue('a-side', { service_id: s1.id });
    const raw = await client.callRaw('enqueue_work', {
      type: 'code',
      title: 'b-side',
      description_markdown: 'x',
      service_id: s2.id,
      depends_on_work_id: upstream.id,
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain('invalid_input');
    // sanity: both apps exist and are different
    expect(a1.id).not.toBe(a2.id);
  });

  it('enqueue_work allows dependency when one item has no service scope', async () => {
    const upstream = await enqueue('no-svc'); // no service_id
    await client.call('register_app', { name: 'app-a' });
    const s1 = (await client.call('register_service', {
      app_name: 'app-a',
      name: 's1',
    })) as { id: number };
    const dependent = await enqueue('scoped', {
      service_id: s1.id,
      depends_on_work_id: upstream.id,
    });
    expect(dependent.depends_on_work_id).toBe(upstream.id);
  });

  it('claim_next_work skips dependents whose upstream is not completed', async () => {
    const upstream = await enqueue('upstream');
    await enqueue('dependent', { depends_on_work_id: upstream.id });

    // First claim returns the upstream (no dep, oldest first).
    const first = (await client.call('claim_next_work', { claimed_by: 'a' })) as WorkRow;
    expect(first.title).toBe('upstream');

    // Second claim returns null because the only other item is gated on the upstream.
    const second = await client.call('claim_next_work', { claimed_by: 'a' });
    expect(second).toBeNull();
  });

  it('dependent becomes claimable once upstream is completed', async () => {
    const upstream = await enqueue('upstream');
    const dependent = await enqueue('dependent', { depends_on_work_id: upstream.id });

    await client.call('claim_next_work', { claimed_by: 'a' }); // claims upstream
    await client.call('complete_work', { id: upstream.id });

    const claimed = (await client.call('claim_next_work', { claimed_by: 'a' })) as WorkRow;
    expect(claimed.id).toBe(dependent.id);
  });

  for (const status of ['claimed', 'failed', 'cancelled', 'blocked', 'awaiting_input'] as const) {
    it(`claim_next_work skips dependent when upstream status is ${status}`, async () => {
      const upstream = await enqueue('upstream');
      await enqueue('dependent', { depends_on_work_id: upstream.id });

      // Force the upstream into the target status without going through tools.
      await db.pool.query(`UPDATE work_items SET status = $2 WHERE id = $1`, [upstream.id, status]);

      const result = await client.call('claim_next_work', { claimed_by: 'a' });
      expect(result).toBeNull();
    });
  }

  it('list_work supports the depends_on_work_id filter', async () => {
    const upstream = await enqueue('upstream');
    await enqueue('depA', { depends_on_work_id: upstream.id });
    await enqueue('depB', { depends_on_work_id: upstream.id });
    await enqueue('unrelated');

    const dependents = (await client.call('list_work', {
      depends_on_work_id: upstream.id,
    })) as WorkRow[];
    expect(dependents.map((r) => r.title).sort()).toEqual(['depA', 'depB']);
  });

  it('deleting the upstream nulls out depends_on_work_id (ON DELETE SET NULL)', async () => {
    const upstream = await enqueue('upstream');
    const dependent = await enqueue('dependent', { depends_on_work_id: upstream.id });

    await db.pool.query(`DELETE FROM work_items WHERE id = $1`, [upstream.id]);

    const fresh = (await client.call('get_work', { id: dependent.id })) as WorkRow;
    expect(fresh.depends_on_work_id).toBeNull();

    // Without an upstream gate, the dependent is now claimable.
    const claimed = (await client.call('claim_next_work', { claimed_by: 'a' })) as WorkRow;
    expect(claimed.id).toBe(dependent.id);
  });
});
