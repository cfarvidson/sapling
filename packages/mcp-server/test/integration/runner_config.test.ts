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
              ntfy_url = NULL,
              awaiting_input_nag_age_ms = DEFAULT,
              awaiting_input_nag_repeat_ms = DEFAULT,
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

  it('accepts ntfy_url, awaiting_input_nag_age_ms, awaiting_input_nag_repeat_ms', async () => {
    const out = (await client.call('update_runner_config', {
      ntfy_url: 'http://localhost:8080/sapling',
      awaiting_input_nag_age_ms: 60_000,
      awaiting_input_nag_repeat_ms: 300_000,
    })) as Record<string, unknown>;
    expect(out.ntfy_url).toBe('http://localhost:8080/sapling');
    expect(out.awaiting_input_nag_age_ms).toBe(60_000);
    expect(out.awaiting_input_nag_repeat_ms).toBe(300_000);
  });

  it('accepts explicit null to clear ntfy_url', async () => {
    await client.call('update_runner_config', { ntfy_url: 'http://localhost:8080/sapling' });
    const out = (await client.call('update_runner_config', {
      ntfy_url: null,
    })) as Record<string, unknown>;
    expect(out.ntfy_url).toBeNull();
  });

  it('rejects empty-string ntfy_url with invalid_input', async () => {
    const raw = await client.callRaw('update_runner_config', { ntfy_url: '' });
    expect(raw.isError).toBe(true);
  });

  it('rejects non-positive nag thresholds with invalid_input', async () => {
    const raw = await client.callRaw('update_runner_config', { awaiting_input_nag_age_ms: 0 });
    expect(raw.isError).toBe(true);
  });

  it('get_runner_config returns the new fields with defaults', async () => {
    const out = (await client.call('get_runner_config', {})) as Record<string, unknown>;
    expect(out.ntfy_url).toBeNull();
    expect(out.awaiting_input_nag_age_ms).toBe(3600000);
    expect(out.awaiting_input_nag_repeat_ms).toBe(21600000);
  });
});
