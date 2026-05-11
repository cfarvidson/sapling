import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('schedule CRUD tools', () => {
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
    await db.pool.query(`TRUNCATE schedules, schedule_runs RESTART IDENTITY CASCADE`);
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    await db.pool.query(`INSERT INTO apps(name) VALUES ('crud-app')`);
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  const valid = {
    name: 's1',
    source_type: 'app' as const,
    app_name: 'crud-app',
    cron_expr: '0 9 * * 1-5',
    timezone: 'Europe/Stockholm',
    title_template: 'Weekly review {{date}}',
    description_md: 'review repos',
    definition_of_done_md: 'reviews posted',
  };

  it('create_schedule happy path computes next_run_at', async () => {
    const out = (await client.call('create_schedule', valid)) as {
      id: number;
      next_run_at: string;
    };
    expect(out.id).toBeTypeOf('number');
    expect(new Date(out.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects invalid cron with invalid_input', async () => {
    const raw = await client.callRaw('create_schedule', { ...valid, cron_expr: 'nope' });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/cron/i);
  });

  it('rejects unknown timezone with invalid_input', async () => {
    const raw = await client.callRaw('create_schedule', { ...valid, timezone: 'Mars/Olympus' });
    expect(raw.isError).toBe(true);
  });

  it('rejects github_org source without github_org string', async () => {
    const raw = await client.callRaw('create_schedule', {
      ...valid,
      name: 's-no-org',
      source_type: 'github_org',
    });
    expect(raw.isError).toBe(true);
  });

  it('name uniqueness returns conflict', async () => {
    await client.call('create_schedule', valid);
    const raw = await client.callRaw('create_schedule', valid);
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/conflict|exists|unique/i);
  });

  it('get_schedule returns schedule + last_run + last_5_runs + next 3 ticks', async () => {
    const created = (await client.call('create_schedule', valid)) as { id: number };
    const out = (await client.call('get_schedule', { id_or_name: created.id })) as {
      schedule: { id: number };
      last_run: unknown | null;
      last_5_runs: unknown[];
      next_3_fires: string[];
    };
    expect(out.schedule.id).toBe(created.id);
    expect(out.last_run).toBeNull();
    expect(out.last_5_runs).toEqual([]);
    expect(out.next_3_fires).toHaveLength(3);
  });

  it('list_schedules filters by app_name and enabled', async () => {
    await client.call('create_schedule', valid);
    await client.call('create_schedule', { ...valid, name: 's2' });
    const all = (await client.call('list_schedules', {})) as unknown[];
    expect(all).toHaveLength(2);
    const filtered = (await client.call('list_schedules', { app_name: 'crud-app' })) as unknown[];
    expect(filtered).toHaveLength(2);
  });

  it('update_schedule recomputes next_run_at when cron_expr changes', async () => {
    const created = (await client.call('create_schedule', valid)) as {
      id: number;
      next_run_at: string;
    };
    const before = new Date(created.next_run_at).getTime();
    const updated = (await client.call('update_schedule', {
      id: created.id,
      cron_expr: '*/5 * * * *',
    })) as { next_run_at: string };
    expect(new Date(updated.next_run_at).getTime()).not.toBe(before);
  });

  it('update_schedule rejects non-patchable fields even alongside patchable ones', async () => {
    const created = (await client.call('create_schedule', valid)) as { id: number };
    // name alone — should error (currently passes by accident)
    const raw1 = await client.callRaw('update_schedule', {
      id: created.id,
      name: 'new-name',
    });
    expect(raw1.isError).toBe(true);
    // name with a patchable field — proves silent stripping is no longer happening
    const raw2 = await client.callRaw('update_schedule', {
      id: created.id,
      name: 'new-name',
      timezone: 'UTC',
    });
    expect(raw2.isError).toBe(true);
  });

  it('enable/disable flips the flag and recomputes next_run_at on re-enable', async () => {
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await client.call('disable_schedule', { id: c.id });
    const off = (await client.call('get_schedule', { id_or_name: c.id })) as {
      schedule: { enabled: boolean };
    };
    expect(off.schedule.enabled).toBe(false);
    await client.call('enable_schedule', { id: c.id });
    const on = (await client.call('get_schedule', { id_or_name: c.id })) as {
      schedule: { enabled: boolean; next_run_at: string };
    };
    expect(on.schedule.enabled).toBe(true);
    expect(new Date(on.schedule.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('delete_schedule cascades schedule_runs but not projects', async () => {
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await db.pool.query(`INSERT INTO schedule_runs(schedule_id, status) VALUES ($1, 'fired')`, [
      c.id,
    ]);
    await client.call('delete_schedule', { id: c.id });
    const { rowCount } = await db.pool.query(`SELECT 1 FROM schedule_runs WHERE schedule_id = $1`, [
      c.id,
    ]);
    expect(rowCount).toBe(0);
  });

  it('run_schedule_now fires immediately, ignoring next_run_at', async () => {
    await db.pool.query(`INSERT INTO services(app_id, name, repo_url) VALUES (1, 'svc', 'u')`);
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() + interval '1 year' WHERE id = $1`,
      [c.id],
    );
    const out = (await client.call('run_schedule_now', { id: c.id })) as { status: string };
    expect(out.status).toBe('fired');
  });

  it('update_schedule does NOT recompute next_run_at when only non-cron fields change (regression for C-01)', async () => {
    const created = (await client.call('create_schedule', valid)) as {
      id: number;
      next_run_at: string;
    };
    const before = new Date(created.next_run_at).getTime();
    // Patch a non-cron field only.
    const updated = (await client.call('update_schedule', {
      id: created.id,
      title_template: 'Re-titled',
    })) as { next_run_at: string };
    expect(new Date(updated.next_run_at).getTime()).toBe(before);
  });
});
