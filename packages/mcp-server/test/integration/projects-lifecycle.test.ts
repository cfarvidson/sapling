import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects — end-to-end lifecycles', () => {
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

  it('full scoping flow: create → scope → plans → code → reviews → DoD verifier → done', async () => {
    const apr = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('iris') RETURNING id`,
    );
    const svc = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc') RETURNING id`,
      [apr.rows[0].id],
    );

    // 1. Create — scoping path.
    const create = (await client.call('create_project', {
      app_name: 'iris',
      title: 'Add SSO',
      description_md: 'Wire SAML',
      definition_of_done_md: 'Users can log in via Okta.',
    })) as { project: { id: number }; scoping_work: { id: number } };
    const projectId = create.project.id;
    const scopingWorkId = create.scoping_work.id;

    // 2. Scoping agent declares scope and completes its work.
    await client.call('complete_scoping', {
      project_id: projectId,
      service_ids: [svc.rows[0].id],
    });
    await client.call('complete_work', { id: scopingWorkId });

    // 3. Plan agent creates a plan + enqueues code work.
    const plan = await db.pool.query<{ id: number }>(
      `INSERT INTO plans(title, body_markdown, service_id, project_id, status)
       VALUES ('p', 'b', $1, $2, 'active') RETURNING id`,
      [svc.rows[0].id, projectId],
    );
    // Find the per-service plan-type work item enqueued by complete_scoping and complete it.
    const perServicePlanWork = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items
        WHERE project_id=$1 AND type='plan' AND title LIKE 'Plan service%'`,
      [projectId],
    );
    await client.call('complete_work', { id: perServicePlanWork.rows[0].id });
    const code = (await client.call('enqueue_work', {
      type: 'code',
      title: 'c',
      description_markdown: 'd',
      service_id: svc.rows[0].id,
      plan_id: plan.rows[0].id,
      project_id: projectId,
    })) as { id: number };

    // 4. Complete the code → per-plan review auto-enqueues.
    await client.call('complete_work', { id: code.id });
    const review = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE plan_id=$1 AND type='review' AND is_dod_verifier=false`,
      [plan.rows[0].id],
    );
    expect(review.rowCount).toBe(1);

    // 5. Complete the per-plan review → DoD verifier auto-enqueues.
    await client.call('complete_work', { id: review.rows[0].id });
    const verifier = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifier.rowCount).toBe(1);

    // 6. Complete the verifier → project flips to done.
    await client.call('complete_work', { id: verifier.rows[0].id });
    const proj = await db.pool.query<{ status: string }>(
      `SELECT status FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('done');
  });

  it('ad-hoc enqueue: extra work item under a project gates the DoD verifier', async () => {
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
    const projectId = r.project.id;

    // Ad-hoc: enqueue a code item directly under the project (no plan) BEFORE
    // completing the plan work item so it gates the DoD verifier.
    const adhoc = (await client.call('enqueue_work', {
      type: 'code',
      title: 'extra',
      description_markdown: 'd',
      project_id: projectId,
    })) as { id: number };

    // Complete the per-service plan work item — verifier still not created because
    // the ad-hoc code item is still pending.
    await client.call('complete_work', { id: r.plan_work_items[0].id });

    // Verifier should NOT exist yet.
    let verifiers = await db.pool.query(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rowCount).toBe(0);

    // Complete the ad-hoc → verifier auto-enqueues now.
    await client.call('complete_work', { id: adhoc.id });
    verifiers = await db.pool.query(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rowCount).toBe(1);
  });

  it('DoD verifier failure path: dod_verified=false bumps counter, fixes complete, fresh verifier auto-arms, success on round two', async () => {
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
    const projectId = r.project.id;
    await client.call('complete_work', { id: r.plan_work_items[0].id });

    const verifier = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );

    await client.call('attach_artifact', {
      kind: 'dod_gaps',
      title: 'Missing tests',
      body_markdown: 'No e2e tests for Okta path.',
      work_item_id: verifier.rows[0].id,
    });
    const fix = (await client.call('enqueue_work', {
      type: 'code',
      title: 'add tests',
      description_markdown: 'd',
      service_id: svc.rows[0].id,
      project_id: projectId,
    })) as { id: number };
    await client.call('complete_work', { id: verifier.rows[0].id, dod_verified: false });

    let proj = await db.pool.query<{ status: string; dod_cycle_count: number }>(
      `SELECT status, dod_cycle_count FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('in_progress');
    expect(proj.rows[0].dod_cycle_count).toBe(1);

    await client.call('complete_work', { id: fix.id });

    const v2 = await db.pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM work_items
         WHERE project_id=$1 AND is_dod_verifier=true
         ORDER BY id DESC LIMIT 1`,
      [projectId],
    );
    expect(v2.rows[0].status).toBe('pending');

    await client.call('complete_work', { id: v2.rows[0].id, dod_verified: true });
    proj = await db.pool.query<{ status: string; dod_cycle_count: number }>(
      `SELECT status, dod_cycle_count FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('done');
    expect(proj.rows[0].dod_cycle_count).toBe(1);
  });

  it('app delete cascade: deleting an app removes its projects and orphans work_items.project_id', async () => {
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

    // App delete cascades through services (existing) → projects (new).
    await db.pool.query(`DELETE FROM apps WHERE id=$1`, [apr.rows[0].id]);

    const projects = await db.pool.query(`SELECT id FROM projects`);
    expect(projects.rowCount).toBe(0);
    // The plan-type work item persists but its project_id is NULL (services + projects both gone,
    // and work_items.project_id and work_items.service_id are ON DELETE SET NULL).
    const work = await db.pool.query<{ project_id: number | null }>(
      `SELECT project_id FROM work_items WHERE id=$1`,
      [r.plan_work_items[0].id],
    );
    expect(work.rows[0].project_id).toBeNull();
  });
});
