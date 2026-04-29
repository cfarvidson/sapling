import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('enqueue_work — team_id resolution chain', () => {
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
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  async function makeTeam(name: string, app_id?: number) {
    return (await client.call('create_team', {
      name,
      app_id,
      lead_prompt_md: 'lead',
      roles: [{ name: 'r', description_md: 'd' }],
    })) as { id: number };
  }

  it('explicit team_id wins over any default', async () => {
    const explicit = await makeTeam('explicit');
    const fallback = await makeTeam('fallback');
    await client.call('set_team_default', { work_type: 'code', team_id: fallback.id });
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
      team_id: explicit.id,
    })) as { team_id: number };
    expect(w.team_id).toBe(explicit.id);
  });

  it('per-app default beats global default when service is set', async () => {
    const globalT = await makeTeam('global');
    const app = (await client.call('register_app', { name: 'iris' })) as { id: number };
    const irisT = await makeTeam('iris-team', app.id);
    const svc = (await client.call('register_service', {
      app_name: 'iris',
      name: 'svc',
    })) as { id: number };

    await client.call('set_team_default', { work_type: 'code', team_id: globalT.id });
    await client.call('set_team_default', { work_type: 'code', team_id: irisT.id, app_id: app.id });

    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
      service_id: svc.id,
    })) as { team_id: number };
    expect(w.team_id).toBe(irisT.id);
  });

  it('global default applies when no per-app default exists', async () => {
    const globalT = await makeTeam('global');
    await client.call('set_team_default', { work_type: 'code', team_id: globalT.id });
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
    })) as { team_id: number };
    expect(w.team_id).toBe(globalT.id);
  });

  it('team_id is null when no default and no explicit value (solo agent)', async () => {
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
    })) as { team_id: number | null };
    expect(w.team_id).toBeNull();
  });

  it('rejects explicit team_id when the team is scoped to a different app', async () => {
    const a = (await client.call('register_app', { name: 'a' })) as { id: number };
    const b = (await client.call('register_app', { name: 'b' })) as { id: number };
    const aTeam = await makeTeam('a-team', a.id);
    const bSvc = (await client.call('register_service', {
      app_name: 'b',
      name: 'svc',
    })) as { id: number };

    const raw = await client.callRaw('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
      service_id: bSvc.id,
      team_id: aTeam.id,
    });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error.code).toBe('invalid_input');

    // Suppress unused-var warnings.
    void b;
  });

  it('default lookup ignores the work item type if no matching default exists', async () => {
    const t = await makeTeam('plan-team');
    await client.call('set_team_default', { work_type: 'plan', team_id: t.id });
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'd',
    })) as { team_id: number | null };
    expect(w.team_id).toBeNull();
  });
});
