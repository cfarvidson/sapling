import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('runner_config tools', () => {
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
    // Reset only the singleton row (not the table — DEFAULT row is seeded at migration time).
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

  it('seeds exactly one row with documented defaults', async () => {
    const cfg = (await client.call('get_runner_config', {})) as {
      id: number;
      agent_command: string;
      max_concurrent: number;
      poll_interval_ms: number;
      claim_ttl_ms: number;
      max_claim_attempts: number;
    };
    expect(cfg.id).toBe(1);
    expect(cfg.agent_command).toBe('claude --dangerously-skip-permissions -p "/sapling:work"');
    expect(cfg.max_concurrent).toBe(2);
    expect(cfg.poll_interval_ms).toBe(30000);
    expect(cfg.claim_ttl_ms).toBe(7200000);
    expect(cfg.max_claim_attempts).toBe(5);

    const { rowCount } = await db.pool.query(`SELECT id FROM runner_config`);
    expect(rowCount).toBe(1);
  });

  it('partial patch leaves other fields untouched', async () => {
    const before = (await client.call('get_runner_config', {})) as {
      agent_command: string;
      claim_ttl_ms: number;
    };
    const patched = (await client.call('update_runner_config', {
      poll_interval_ms: 5000,
    })) as {
      poll_interval_ms: number;
      agent_command: string;
      claim_ttl_ms: number;
    };
    expect(patched.poll_interval_ms).toBe(5000);
    expect(patched.agent_command).toBe(before.agent_command);
    expect(patched.claim_ttl_ms).toBe(before.claim_ttl_ms);
  });

  it('rejects empty patch', async () => {
    const raw = await client.callRaw('update_runner_config', {});
    expect(raw.isError).toBe(true);
  });

  it('rejects non-positive integers', async () => {
    const zero = await client.callRaw('update_runner_config', { poll_interval_ms: 0 });
    expect(zero.isError).toBe(true);
    const neg = await client.callRaw('update_runner_config', { max_concurrent: -1 });
    expect(neg.isError).toBe(true);
  });
});
