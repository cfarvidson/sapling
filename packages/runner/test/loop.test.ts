import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '../src/loop.js';
import type { SpawnedAgent, SpawnFn } from '../src/spawn.js';
import { startTestDb, type TestDb } from './helpers/pg.js';
import { startInProcessMcp, type InProcessMcp } from './helpers/mcp-fixture.js';

interface StubChild extends SpawnedAgent {
  resolveExit: (code: number) => void;
}

interface StubSpawn {
  fn: SpawnFn;
  calls: Array<{ command: string; child: StubChild }>;
}

function makeStubSpawn(): StubSpawn {
  const calls: Array<{ command: string; child: StubChild }> = [];
  let pidCounter = 1000;
  const fn: SpawnFn = (command) => {
    let resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const onExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
      resolveExit = r;
    });
    const child: StubChild = {
      pid: pidCounter++,
      onExit,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        resolveExit({ code: null, signal });
        return true;
      },
      resolveExit: (code: number) => resolveExit({ code, signal: null }),
    };
    calls.push({ command, child });
    return child;
  };
  return { fn, calls };
}

async function flushMicrotasks(): Promise<void> {
  // Two awaits guarantee any chained .then microtasks have drained.
  await Promise.resolve();
  await Promise.resolve();
}

describe('runner loop tick', () => {
  let db: TestDb;
  let fixture: InProcessMcp;

  beforeAll(async () => {
    db = await startTestDb();
    fixture = await startInProcessMcp(db.pool);
  });

  afterAll(async () => {
    await fixture?.close();
    await db?.stop();
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
  });

  async function enqueue(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.pool.query(
        `INSERT INTO work_items(type, title, description_markdown)
         VALUES ('plan', $1, $2)`,
        [`task ${i}`, 'x'],
      );
    }
  }

  it('spawns one agent per tick when max_concurrent=1 and running drains between ticks', async () => {
    await enqueue(3);
    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();

    for (let i = 0; i < 3; i++) {
      const r = await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
      expect(r.spawned).toBe(1);
      // Resolve the spawned child so running drains before next tick.
      stub.calls[i].child.resolveExit(0);
      await flushMicrotasks();
      expect(running.size).toBe(0);
    }
    expect(stub.calls).toHaveLength(3);
  });

  it('caps spawns at max_concurrent in a single tick', async () => {
    await db.pool.query(`UPDATE runner_config SET max_concurrent = 2 WHERE id = 1`);
    await enqueue(5);

    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();

    const r = await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
    expect(r.spawned).toBe(2);
    expect(r.pending).toBe(5);
    expect(running.size).toBe(2);
    expect(stub.calls).toHaveLength(2);
  });

  it('does not spawn when running is already at capacity', async () => {
    await db.pool.query(`UPDATE runner_config SET max_concurrent = 2 WHERE id = 1`);
    await enqueue(5);

    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();

    // First tick fills the slots.
    await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
    expect(running.size).toBe(2);
    // Second tick should not spawn — running is at max.
    const r = await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
    expect(r.spawned).toBe(0);
    expect(stub.calls).toHaveLength(2);
  });

  it('passes the configured agent_command and env through to spawn', async () => {
    await db.pool.query(
      `UPDATE runner_config SET agent_command = 'fake-agent --flag' WHERE id = 1`,
    );
    await enqueue(1);

    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();

    await tick({
      mcp: fixture.mcp,
      spawn: stub.fn,
      env: { FOO: 'bar' } as NodeJS.ProcessEnv,
      running,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].command).toBe('fake-agent --flag');
  });

  it('reaps stuck claims at the start of a tick', async () => {
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown)
       VALUES ('plan', 't', 'x') RETURNING id`,
    );
    const id = rows[0].id;
    // Simulate a claim that has expired.
    await db.pool.query(
      `UPDATE work_items
          SET status = 'claimed',
              claimed_at = now() - interval '4 hours',
              claimed_by = 'crashy-agent',
              claim_expires_at = now() - interval '1 hour',
              attempt_count = 1
        WHERE id = $1`,
      [id],
    );

    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();
    const r = await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
    expect(r.reaped).toBe(1);

    const after = await db.pool.query<{ status: string }>(
      `SELECT status FROM work_items WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe('pending');
    // The reaped item is now pending and was spawned-against in the same tick.
    expect(stub.calls).toHaveLength(1);
  });

  it('respects backoff: claim_next_work skips an item with next_retry_at in the future', async () => {
    // tick itself counts pending via list_work (which does not filter by next_retry_at),
    // so it may spawn against a backed-off item. The end-to-end backoff guarantee comes
    // from claim_next_work's predicate — verify that explicitly here.
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown)
       VALUES ('plan', 't', 'x') RETURNING id`,
    );
    const id = rows[0].id;
    await db.pool.query(
      `UPDATE work_items SET next_retry_at = now() + interval '60 seconds' WHERE id = $1`,
      [id],
    );

    // The stub spawn does not actually claim; the item must remain pending.
    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();
    await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });

    const after = await db.pool.query<{ status: string }>(
      `SELECT status FROM work_items WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe('pending');

    // claim_next_work should also refuse the row (this is the real backoff guarantee).
    const claimRes = (await fixture.client.callTool({
      name: 'claim_next_work',
      arguments: { claimed_by: 'test-agent' },
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(claimRes.content[0].text)).toBeNull();
  });

  it('returns 0 spawned when nothing is pending', async () => {
    const stub = makeStubSpawn();
    const running = new Set<SpawnedAgent>();
    const r = await tick({ mcp: fixture.mcp, spawn: stub.fn, env: {}, running });
    expect(r).toMatchObject({ reaped: 0, spawned: 0, pending: 0, running: 0 });
    expect(stub.calls).toHaveLength(0);
  });
});
