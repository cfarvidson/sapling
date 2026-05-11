import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects — DoD fix loop', () => {
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
    await db.pool.query(`UPDATE runner_config SET max_dod_fix_cycles = 3 WHERE id = 1`);
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  async function seedProjectWithVerifier(): Promise<{
    projectId: number;
    serviceId: number;
    verifierId: number;
  }> {
    const apr = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('iris') RETURNING id`,
    );
    const svc = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc') RETURNING id`,
      [apr.rows[0].id],
    );
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'X',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc.rows[0].id],
    })) as { project: { id: number }; plan_work_items: Array<{ id: number }> };
    await client.call('complete_work', { id: r.plan_work_items[0].id });
    const verifier = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [r.project.id],
    );
    return {
      projectId: r.project.id,
      serviceId: svc.rows[0].id,
      verifierId: verifier.rows[0].id,
    };
  }

  it('single fix cycle: verifier unverified bumps counter, project stays in_progress', async () => {
    const { projectId, verifierId } = await seedProjectWithVerifier();

    await client.call('complete_work', { id: verifierId, dod_verified: false });

    const proj = await db.pool.query<{ status: string; dod_cycle_count: number }>(
      `SELECT status, dod_cycle_count FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('in_progress');
    expect(proj.rows[0].dod_cycle_count).toBe(1);
  });
});
