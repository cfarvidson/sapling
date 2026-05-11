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

  it('after a failed verifier, completing fix items re-arms a fresh verifier', async () => {
    const { projectId, serviceId, verifierId } = await seedProjectWithVerifier();

    const fix = (await client.call('enqueue_work', {
      type: 'code',
      title: 'add tests',
      description_markdown: 'd',
      service_id: serviceId,
      project_id: projectId,
    })) as { id: number };

    await client.call('complete_work', { id: verifierId, dod_verified: false });

    let verifiers = await db.pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true
         ORDER BY id ASC`,
      [projectId],
    );
    expect(verifiers.rowCount).toBe(1);
    expect(verifiers.rows[0].status).toBe('completed');

    await client.call('complete_work', { id: fix.id });

    verifiers = await db.pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true
         ORDER BY id ASC`,
      [projectId],
    );
    expect(verifiers.rowCount).toBe(2);
    expect(verifiers.rows[1].status).toBe('pending');
  });

  it('happy path: dod_verified=true flips project to done, counter stays at 0', async () => {
    const { projectId, verifierId } = await seedProjectWithVerifier();
    await client.call('complete_work', { id: verifierId, dod_verified: true });
    const proj = await db.pool.query<{ status: string; dod_cycle_count: number }>(
      `SELECT status, dod_cycle_count FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('done');
    expect(proj.rows[0].dod_cycle_count).toBe(0);
  });

  it('backwards compat: omitting dod_verified on a verifier defaults to verified=true', async () => {
    const { projectId, verifierId } = await seedProjectWithVerifier();
    await client.call('complete_work', { id: verifierId });
    const proj = await db.pool.query<{ status: string; dod_cycle_count: number }>(
      `SELECT status, dod_cycle_count FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('done');
    expect(proj.rows[0].dod_cycle_count).toBe(0);
  });

  it('strictness: dod_verified on a non-verifier work item returns invalid_input', async () => {
    const apr = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('iris') RETURNING id`,
    );
    const svc = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc') RETURNING id`,
      [apr.rows[0].id],
    );
    const code = (await client.call('enqueue_work', {
      type: 'code',
      title: 'c',
      description_markdown: 'd',
      service_id: svc.rows[0].id,
    })) as { id: number };

    const raw = await client.callRaw('complete_work', {
      id: code.id,
      dod_verified: false,
    });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error.code).toBe('invalid_input');

    const w = await db.pool.query<{ status: string }>(
      `SELECT status FROM work_items WHERE id=$1`,
      [code.id],
    );
    expect(w.rows[0].status).toBe('pending');
  });

  it('cap reached: two consecutive failed verifiers with cap=2 blocks the project', async () => {
    await db.pool.query(`UPDATE runner_config SET max_dod_fix_cycles = 2 WHERE id = 1`);
    const { projectId, serviceId, verifierId } = await seedProjectWithVerifier();

    const fix1 = (await client.call('enqueue_work', {
      type: 'code',
      title: 'fix1',
      description_markdown: 'd',
      service_id: serviceId,
      project_id: projectId,
    })) as { id: number };

    await client.call('complete_work', { id: verifierId, dod_verified: false });
    await client.call('complete_work', { id: fix1.id });

    const v2 = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true AND status='pending'`,
      [projectId],
    );
    expect(v2.rowCount).toBe(1);

    await client.call('complete_work', { id: v2.rows[0].id, dod_verified: false });

    const proj = await db.pool.query<{
      status: string;
      dod_cycle_count: number;
      failure_reason: string | null;
    }>(`SELECT status, dod_cycle_count, failure_reason FROM projects WHERE id=$1`, [projectId]);
    expect(proj.rows[0].status).toBe('blocked');
    expect(proj.rows[0].dod_cycle_count).toBe(2);
    expect(proj.rows[0].failure_reason).toBe('DoD not verified after 2 cycles');

    const fix2 = (await client.call('enqueue_work', {
      type: 'code',
      title: 'fix2',
      description_markdown: 'd',
      service_id: serviceId,
      project_id: projectId,
    })) as { id: number };
    await client.call('complete_work', { id: fix2.id });

    const verifiers = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rows[0].n).toBe(2);
  });

  it('per-plan trigger isolation: fix items with plan_id=NULL do not auto-enqueue a per-plan review', async () => {
    const { projectId, serviceId, verifierId } = await seedProjectWithVerifier();

    const fix = (await client.call('enqueue_work', {
      type: 'code',
      title: 'plan-less fix',
      description_markdown: 'd',
      service_id: serviceId,
      project_id: projectId,
    })) as { id: number };

    await client.call('complete_work', { id: verifierId, dod_verified: false });
    await client.call('complete_work', { id: fix.id });

    const perPlanReviews = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE project_id=$1
           AND type='review'
           AND is_dod_verifier=false
           AND plan_id IS NULL`,
      [projectId],
    );
    expect(perPlanReviews.rows[0].n).toBe(0);
  });

  it('unblock after cap: resets dod_cycle_count to 0 and re-arms one fresh verifier', async () => {
    await db.pool.query(`UPDATE runner_config SET max_dod_fix_cycles = 1 WHERE id = 1`);
    const { projectId, verifierId } = await seedProjectWithVerifier();

    await client.call('complete_work', { id: verifierId, dod_verified: false });

    let proj = await db.pool.query<{
      status: string;
      dod_cycle_count: number;
      failure_reason: string | null;
    }>(`SELECT status, dod_cycle_count, failure_reason FROM projects WHERE id=$1`, [projectId]);
    expect(proj.rows[0].status).toBe('blocked');
    expect(proj.rows[0].dod_cycle_count).toBe(1);
    expect(proj.rows[0].failure_reason).toBe('DoD not verified after 1 cycles');

    await client.call('unblock_project', { id: projectId });

    proj = await db.pool.query<{
      status: string;
      dod_cycle_count: number;
      failure_reason: string | null;
    }>(`SELECT status, dod_cycle_count, failure_reason FROM projects WHERE id=$1`, [projectId]);
    expect(proj.rows[0].status).toBe('in_progress');
    expect(proj.rows[0].dod_cycle_count).toBe(0);

    const verifiers = await db.pool.query<{ status: string }>(
      `SELECT status FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true
         ORDER BY id DESC LIMIT 1`,
      [projectId],
    );
    expect(verifiers.rows[0].status).toBe('pending');
  });

  it('unblock without cap: preserves dod_cycle_count when the block was manual', async () => {
    const { projectId, verifierId } = await seedProjectWithVerifier();
    await client.call('complete_work', { id: verifierId, dod_verified: false });
    await client.call('block_project', { id: projectId, reason: 'manual hold' });

    let proj = await db.pool.query<{ dod_cycle_count: number; status: string }>(
      `SELECT dod_cycle_count, status FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('blocked');
    expect(proj.rows[0].dod_cycle_count).toBe(1);

    await client.call('unblock_project', { id: projectId });

    proj = await db.pool.query<{ dod_cycle_count: number; status: string }>(
      `SELECT dod_cycle_count, status FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('in_progress');
    expect(proj.rows[0].dod_cycle_count).toBe(1);
  });

  it('regression: existing pending/claimed verifier blocks re-arm; only stale completed ones do not', async () => {
    const { projectId, serviceId, verifierId } = await seedProjectWithVerifier();

    const extra = (await client.call('enqueue_work', {
      type: 'code',
      title: 'extra',
      description_markdown: 'd',
      service_id: serviceId,
      project_id: projectId,
    })) as { id: number };
    await client.call('complete_work', { id: extra.id });

    let verifiers = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rows[0].n).toBe(1);

    await client.call('complete_work', { id: verifierId, dod_verified: true });
    verifiers = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rows[0].n).toBe(1);
  });
});
