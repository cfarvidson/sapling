import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects tools — registration', () => {
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

  it('exposes the nine project tools', async () => {
    // calling an unknown tool throws; calling a known tool with bad args returns isError.
    const expected = [
      'create_project',
      'complete_scoping',
      'get_project',
      'list_projects',
      'update_project',
      'cancel_project',
      'block_project',
      'unblock_project',
      'retry_project',
    ];
    for (const name of expected) {
      const raw = await client.callRaw(name, {});
      // Each tool is registered (no MethodNotFound). Either it accepts {} (returns isError)
      // or zod rejects it (returns isError). We only assert it doesn't blow up as missing.
      expect(raw).toBeDefined();
    }
  });
});

async function seedApp(db: TestDb, name = 'iris'): Promise<number> {
  const r = await db.pool.query<{ id: number }>(`INSERT INTO apps(name) VALUES ($1) RETURNING id`, [
    name,
  ]);
  return r.rows[0].id;
}

async function seedService(db: TestDb, appId: number, name: string): Promise<number> {
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO services(app_id, name) VALUES ($1, $2) RETURNING id`,
    [appId, name],
  );
  return r.rows[0].id;
}

describe('create_project — scoping path', () => {
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

  it('creates a project in scoping status and auto-enqueues a scoping work item', async () => {
    await seedApp(db, 'iris');
    const result = (await client.call('create_project', {
      app_name: 'iris',
      title: 'Add SSO',
      description_md: 'Wire up SAML',
      definition_of_done_md: 'Users can log in via Okta.',
    })) as { project: { id: number; status: string }; scoping_work: { id: number; type: string } };

    expect(result.project.status).toBe('scoping');

    const project = await db.pool.query(`SELECT * FROM projects WHERE id=$1`, [result.project.id]);
    expect(project.rows[0]).toMatchObject({
      title: 'Add SSO',
      description_md: 'Wire up SAML',
      definition_of_done_md: 'Users can log in via Okta.',
      status: 'scoping',
    });

    expect(result.scoping_work.type).toBe('plan');
    const work = await db.pool.query(`SELECT * FROM work_items WHERE id=$1`, [
      result.scoping_work.id,
    ]);
    expect(work.rows[0]).toMatchObject({
      type: 'plan',
      project_id: result.project.id,
      status: 'pending',
    });
    expect(work.rows[0].title).toContain('Scope project');
  });

  it('rejects unknown app_name with not_found', async () => {
    const raw = await client.callRaw('create_project', {
      app_name: 'nope',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('rejects empty definition_of_done_md with invalid_input', async () => {
    await seedApp(db, 'iris');
    const raw = await client.callRaw('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: '',
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });
});

describe('create_project — fast path (service_ids supplied)', () => {
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

  it('skips scoping and fans out one plan work item per service', async () => {
    const appId = await seedApp(db, 'iris');
    const a = await seedService(db, appId, 'svc-a');
    const b = await seedService(db, appId, 'svc-b');

    const result = (await client.call('create_project', {
      app_name: 'iris',
      title: 'Bump dep',
      description_md: 'Bump foo to 2.0',
      definition_of_done_md: 'foo@2.0 used everywhere; tests pass.',
      service_ids: [a, b],
    })) as {
      project: { id: number; status: string };
      plan_work_items: Array<{ id: number; service_id: number; type: string; project_id: number }>;
    };

    expect(result.project.status).toBe('in_progress');
    expect(result.plan_work_items).toHaveLength(2);
    expect(new Set(result.plan_work_items.map((w) => w.service_id))).toEqual(new Set([a, b]));
    for (const w of result.plan_work_items) {
      expect(w.type).toBe('plan');
      expect(w.project_id).toBe(result.project.id);
    }

    const noScoping = await db.pool.query(
      `SELECT count(*)::int AS n FROM work_items WHERE project_id=$1 AND title LIKE 'Scope project%'`,
      [result.project.id],
    );
    expect(noScoping.rows[0].n).toBe(0);
  });

  it('rejects service_ids that belong to a different app', async () => {
    const irisId = await seedApp(db, 'iris');
    const otherId = await seedApp(db, 'other');
    const otherSvc = await seedService(db, otherId, 'foreign');
    void irisId;

    const raw = await client.callRaw('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [otherSvc],
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/service .* does not belong to app/i);
  });
});

describe('complete_scoping', () => {
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

  async function createScopingProject(): Promise<{
    projectId: number;
    appId: number;
    services: number[];
  }> {
    const appId = await seedApp(db, 'iris');
    const a = await seedService(db, appId, 'svc-a');
    const b = await seedService(db, appId, 'svc-b');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'X',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    return { projectId: r.project.id, appId, services: [a, b] };
  }

  it('flips project to in_progress and fans out per-service plan work items', async () => {
    const { projectId, services } = await createScopingProject();
    const result = (await client.call('complete_scoping', {
      project_id: projectId,
      service_ids: services,
    })) as {
      project: { id: number; status: string };
      plan_work_items: Array<{ id: number; service_id: number; type: string }>;
    };
    expect(result.project.status).toBe('in_progress');
    expect(result.plan_work_items).toHaveLength(2);
    expect(new Set(result.plan_work_items.map((w) => w.service_id))).toEqual(new Set(services));
  });

  it('rejects empty service_ids with invalid_input', async () => {
    const { projectId } = await createScopingProject();
    const raw = await client.callRaw('complete_scoping', {
      project_id: projectId,
      service_ids: [],
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('rejects services from a different app with invalid_input', async () => {
    const { projectId } = await createScopingProject();
    const otherApp = await seedApp(db, 'other');
    const foreign = await seedService(db, otherApp, 'foreign');
    const raw = await client.callRaw('complete_scoping', {
      project_id: projectId,
      service_ids: [foreign],
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('rejects projects not in scoping status with conflict', async () => {
    const { projectId, services } = await createScopingProject();
    await client.call('complete_scoping', { project_id: projectId, service_ids: services });
    const raw = await client.callRaw('complete_scoping', {
      project_id: projectId,
      service_ids: services,
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });

  it('returns not_found for an unknown project_id', async () => {
    const raw = await client.callRaw('complete_scoping', {
      project_id: 999999,
      service_ids: [1],
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('update_project', () => {
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

  it('patches title, description, DoD, linear_url', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'Old',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    const updated = (await client.call('update_project', {
      id: r.project.id,
      title: 'New',
      definition_of_done_md: 'NEW DOD',
      linear_url: 'https://linear.app/x/issue/X-1',
    })) as { id: number; title: string; definition_of_done_md: string; linear_url: string };
    expect(updated.title).toBe('New');
    expect(updated.definition_of_done_md).toBe('NEW DOD');
    expect(updated.linear_url).toBe('https://linear.app/x/issue/X-1');
  });

  it('rejects empty body with invalid_input', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    const raw = await client.callRaw('update_project', { id: r.project.id });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });
});

describe('get_project / list_projects', () => {
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

  it('get_project returns the row with rolled-up child counts', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'Pid',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number }; scoping_work: { id: number } };

    const got = (await client.call('get_project', { id: r.project.id })) as {
      project: { id: number };
      plan_count: number;
      work_counts: Record<string, number>;
      scoping_artifact_id: number | null;
      dod_verifier_id: number | null;
    };
    expect(got.project.id).toBe(r.project.id);
    expect(got.plan_count).toBe(0);
    // exactly one pending plan-type work item (the scoping one)
    expect(got.work_counts.pending).toBe(1);
    expect(got.scoping_artifact_id).toBeNull();
    expect(got.dod_verifier_id).toBeNull();
  });

  it('get_project returns not_found for unknown id', async () => {
    const raw = await client.callRaw('get_project', { id: 999999 });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('list_projects filters by app_name and status, omits long bodies', async () => {
    await seedApp(db, 'iris');
    await seedApp(db, 'other');
    await client.call('create_project', {
      app_name: 'iris',
      title: 'A',
      description_md: 'd',
      definition_of_done_md: 'dod',
    });
    await client.call('create_project', {
      app_name: 'other',
      title: 'B',
      description_md: 'd',
      definition_of_done_md: 'dod',
    });
    const filtered = (await client.call('list_projects', {
      app_name: 'iris',
    })) as Array<{ id: number; title: string; description_md?: unknown; status: string }>;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('A');
    expect(filtered[0].description_md).toBeUndefined();
    expect(filtered[0].status).toBe('scoping');
  });
});

describe('cancel_project', () => {
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

  it('cascades cancel to all non-terminal child work items', async () => {
    const appId = await seedApp(db, 'iris');
    const a = await seedService(db, appId, 'svc-a');
    const b = await seedService(db, appId, 'svc-b');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'X',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [a, b],
    })) as { project: { id: number }; plan_work_items: Array<{ id: number }> };

    // Mark one of the children completed; it must not be re-cancelled.
    await db.pool.query(`UPDATE work_items SET status='completed' WHERE id=$1`, [
      r.plan_work_items[0].id,
    ]);

    const out = (await client.call('cancel_project', {
      id: r.project.id,
      reason: 'changed direction',
    })) as { id: number; status: string; failure_reason: string };
    expect(out.status).toBe('cancelled');
    expect(out.failure_reason).toBe('changed direction');

    const rows = await db.pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM work_items WHERE project_id = $1 ORDER BY id`,
      [r.project.id],
    );
    expect(rows.rows[0].status).toBe('completed'); // untouched terminal
    expect(rows.rows[1].status).toBe('cancelled');
  });

  it('is idempotent on already-cancelled', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    await client.call('cancel_project', { id: r.project.id });
    const out = (await client.call('cancel_project', { id: r.project.id })) as {
      status: string;
    };
    expect(out.status).toBe('cancelled');
  });

  it('returns not_found for unknown id', async () => {
    const raw = await client.callRaw('cancel_project', { id: 999999 });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('block_project / unblock_project', () => {
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

  it('blocks a scoping project and stores the reason', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    const out = (await client.call('block_project', {
      id: r.project.id,
      reason: 'waiting on infra',
    })) as { project: { status: string; failure_reason: string }; cascade_blocked_count: number };
    expect(out.project.status).toBe('blocked');
    expect(out.project.failure_reason).toBe('waiting on infra');
  });

  it('cascades to pending children with the marker prefix; leaves claimed alone', async () => {
    const appId = await seedApp(db, 'iris');
    const svc = await seedService(db, appId, 'svc');
    const proj = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number }; plan_work_items: Array<{ id: number }> };
    const projectId = proj.project.id;

    // Manually fabricate child rows in each relevant status so we can verify cascade behavior.
    const pendingChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id)
         VALUES ('code', 'p', 'x', $1) RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    const claimedChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id, status,
                                claimed_at, claimed_by, claim_expires_at)
         VALUES ('code', 'c', 'x', $1, 'claimed', now(), 'agent-x',
                 now() + interval '1 hour')
         RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    const completedChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id, status, completed_at)
         VALUES ('code', 'd', 'x', $1, 'completed', now()) RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    const out = (await client.call('block_project', {
      id: projectId,
      reason: 'waiting on infra',
    })) as { project: { status: string }; cascade_blocked_count: number };

    expect(out.project.status).toBe('blocked');
    // The auto-fanned-out plan items (1 per service) + the manually inserted pending child
    // should all be cascaded; the claimed and completed ones should not.
    expect(out.cascade_blocked_count).toBeGreaterThanOrEqual(2);

    const after = await db.pool.query<{
      id: number;
      status: string;
      failure_reason: string | null;
    }>(`SELECT id, status, failure_reason FROM work_items WHERE id IN ($1,$2,$3) ORDER BY id`, [
      pendingChild,
      claimedChild,
      completedChild,
    ]);
    const byId = new Map(after.rows.map((r) => [r.id, r]));
    expect(byId.get(pendingChild)).toMatchObject({
      status: 'blocked',
      failure_reason: 'project blocked: waiting on infra',
    });
    expect(byId.get(claimedChild)?.status).toBe('claimed');
    expect(byId.get(completedChild)?.status).toBe('completed');
  });

  it('cascades to awaiting_input children', async () => {
    const appId = await seedApp(db, 'iris');
    const svc = await seedService(db, appId, 'svc');
    const proj = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number } };
    const awaitingChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id, status)
         VALUES ('code', 'a', 'x', $1, 'awaiting_input') RETURNING id`,
        [proj.project.id],
      )
    ).rows[0].id;

    await client.call('block_project', { id: proj.project.id, reason: 'r' });

    const after = await db.pool.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM work_items WHERE id = $1`,
      [awaitingChild],
    );
    expect(after.rows[0].status).toBe('blocked');
    expect(after.rows[0].failure_reason).toBe('project blocked: r');
  });

  it('does not double-block already-blocked children (idempotent on status)', async () => {
    const appId = await seedApp(db, 'iris');
    const svc = await seedService(db, appId, 'svc');
    const proj = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number } };
    // An operator-blocked child with a *different* reason — must not be re-stamped.
    const operatorBlockedChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id, status, failure_reason)
         VALUES ('code', 'op', 'x', $1, 'blocked', 'operator: external dep') RETURNING id`,
        [proj.project.id],
      )
    ).rows[0].id;

    await client.call('block_project', { id: proj.project.id, reason: 'r' });

    const after = await db.pool.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM work_items WHERE id = $1`,
      [operatorBlockedChild],
    );
    expect(after.rows[0].failure_reason).toBe('operator: external dep');
  });

  it('cascade-unblocks children whose failure_reason starts with the marker prefix', async () => {
    const appId = await seedApp(db, 'iris');
    const svc = await seedService(db, appId, 'svc');
    const proj = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number }; plan_work_items: Array<{ id: number }> };
    const projectId = proj.project.id;
    const operatorBlockedChild = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, project_id, status, failure_reason)
         VALUES ('code', 'op', 'x', $1, 'blocked', 'operator: external dep') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    await client.call('block_project', { id: projectId, reason: 'r' });
    const out = (await client.call('unblock_project', { id: projectId })) as {
      project: { status: string };
      cascade_unblocked_count: number;
    };

    expect(out.cascade_unblocked_count).toBeGreaterThanOrEqual(1);
    // Operator-blocked child stayed blocked.
    const op = await db.pool.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM work_items WHERE id = $1`,
      [operatorBlockedChild],
    );
    expect(op.rows[0].status).toBe('blocked');
    expect(op.rows[0].failure_reason).toBe('operator: external dep');
    // Cascade-blocked children are back to pending with cleared failure_reason.
    const cascaded = await db.pool.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM work_items
        WHERE project_id = $1 AND id <> $2`,
      [projectId, operatorBlockedChild],
    );
    for (const r of cascaded.rows) {
      expect(r.status).toBe('pending');
      expect(r.failure_reason).toBeNull();
    }
  });

  it('replays every completion that happened during the blocked window, not just the most recent', async () => {
    const appId = await seedApp(db, 'iris');
    const svc1 = await seedService(db, appId, 'svc1');
    const svc2 = await seedService(db, appId, 'svc2');
    const proj = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc1, svc2],
    })) as { project: { id: number } };
    const projectId = proj.project.id;

    // Manually wire two plans + one code child each, then complete the code children
    // to set up state where two per-plan reviews would have been auto-enqueued
    // but for the project being blocked.
    const planA = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO plans(title, body_markdown, project_id) VALUES ('A','x',$1) RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    const planB = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO plans(title, body_markdown, project_id) VALUES ('B','x',$1) RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    const codeA = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, plan_id, project_id, status, completed_at)
         VALUES ('code', 'cA', 'x', $1, $2, 'completed', now() - interval '20 minutes') RETURNING id`,
        [planA, projectId],
      )
    ).rows[0].id;
    const codeB = (
      await db.pool.query<{ id: number }>(
        `INSERT INTO work_items(type, title, description_markdown, plan_id, project_id, status, completed_at)
         VALUES ('code', 'cB', 'x', $1, $2, 'completed', now() - interval '10 minutes') RETURNING id`,
        [planB, projectId],
      )
    ).rows[0].id;
    void codeA;
    void codeB;
    await db.pool.query(`UPDATE projects SET status='blocked' WHERE id=$1`, [projectId]);

    await client.call('unblock_project', { id: projectId });

    const reviewsByPlan = await db.pool.query<{ plan_id: number }>(
      `SELECT plan_id FROM work_items
        WHERE project_id = $1 AND type='review' AND is_dod_verifier = false
        ORDER BY plan_id`,
      [projectId],
    );
    const planIds = reviewsByPlan.rows.map((r) => r.plan_id);
    expect(planIds).toEqual([planA, planB].sort((a, b) => a - b));
  });

  it('rejects block from terminal done/cancelled with conflict', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    await client.call('cancel_project', { id: r.project.id });
    const raw = await client.callRaw('block_project', {
      id: r.project.id,
      reason: 'x',
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });

  it('unblock recomputes status: scoping if scoping work in flight, else in_progress', async () => {
    const appId = await seedApp(db, 'iris');
    void appId;

    // Case A: scoping work item still pending → unblock returns to scoping.
    const a = (await client.call('create_project', {
      app_name: 'iris',
      title: 'A',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    await client.call('block_project', { id: a.project.id, reason: 'r' });
    const aOut = (await client.call('unblock_project', { id: a.project.id })) as {
      status: string;
    };
    expect(aOut.status).toBe('scoping');

    // Case B: project was in_progress before block → returns to in_progress.
    const svc = await seedService(db, appId, 'svc');
    const b = (await client.call('create_project', {
      app_name: 'iris',
      title: 'B',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number } };
    await client.call('block_project', { id: b.project.id, reason: 'r' });
    const bOut = (await client.call('unblock_project', { id: b.project.id })) as {
      status: string;
    };
    expect(bOut.status).toBe('in_progress');
  });
});

describe('retry_project', () => {
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

  it('flips a done project back to in_progress and retries the existing DoD verifier', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };

    // Manually fabricate the "done + verifier exists" state so the tool can be tested in isolation.
    await db.pool.query(
      `INSERT INTO work_items(type, title, description_markdown, project_id, is_dod_verifier, status)
       VALUES ('review', 'verify', 'd', $1, true, 'completed')`,
      [r.project.id],
    );
    await db.pool.query(`UPDATE projects SET status='done' WHERE id=$1`, [r.project.id]);

    const out = (await client.call('retry_project', { id: r.project.id })) as {
      project: { status: string };
      verifier: { id: number; status: string };
    };
    expect(out.project.status).toBe('in_progress');
    expect(out.verifier.status).toBe('pending');
  });

  it('returns conflict when project has no DoD verifier yet', async () => {
    await seedApp(db, 'iris');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    const raw = await client.callRaw('retry_project', { id: r.project.id });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });
});

describe('workflow driver — auto-enqueue triggers', () => {
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

  async function setupProjectWithPlanAndCode(): Promise<{
    projectId: number;
    planId: number;
    codeWorkIds: number[];
  }> {
    const appId = await seedApp(db, 'iris');
    const svc = await seedService(db, appId, 'svc');
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 'P',
      description_md: 'd',
      definition_of_done_md: 'dod',
      service_ids: [svc],
    })) as { project: { id: number }; plan_work_items: Array<{ id: number }> };
    // Mark the per-service plan work item completed (without a real plan body needed).
    await db.pool.query(`UPDATE work_items SET status='completed' WHERE id=$1`, [
      r.plan_work_items[0].id,
    ]);
    // Create a real plan row and two code work items beneath it.
    const plan = await db.pool.query<{ id: number }>(
      `INSERT INTO plans(title, body_markdown, service_id, project_id, status)
       VALUES ('p', 'b', $1, $2, 'active') RETURNING id`,
      [svc, r.project.id],
    );
    const code1 = (await client.call('enqueue_work', {
      type: 'code',
      title: 'c1',
      description_markdown: 'd',
      service_id: svc,
      plan_id: plan.rows[0].id,
      project_id: r.project.id,
    })) as { id: number };
    const code2 = (await client.call('enqueue_work', {
      type: 'code',
      title: 'c2',
      description_markdown: 'd',
      service_id: svc,
      plan_id: plan.rows[0].id,
      project_id: r.project.id,
    })) as { id: number };
    return { projectId: r.project.id, planId: plan.rows[0].id, codeWorkIds: [code1.id, code2.id] };
  }

  it('enqueue_work accepts project_id and persists it', async () => {
    const appId = await seedApp(db, 'iris');
    void appId;
    const r = (await client.call('create_project', {
      app_name: 'iris',
      title: 't',
      description_md: 'd',
      definition_of_done_md: 'dod',
    })) as { project: { id: number } };
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 'c',
      description_markdown: 'd',
      project_id: r.project.id,
    })) as { id: number; project_id: number };
    expect(w.project_id).toBe(r.project.id);
  });

  it('completing the last code work under a plan auto-enqueues a per-plan review', async () => {
    const { projectId, planId, codeWorkIds } = await setupProjectWithPlanAndCode();
    await client.call('complete_work', { id: codeWorkIds[0] });
    let reviews = await db.pool.query(
      `SELECT count(*)::int AS n FROM work_items WHERE plan_id=$1 AND type='review'`,
      [planId],
    );
    expect(reviews.rows[0].n).toBe(0);
    await client.call('complete_work', { id: codeWorkIds[1] });
    reviews = await db.pool.query(
      `SELECT type, project_id, plan_id FROM work_items WHERE plan_id=$1 AND type='review'`,
      [planId],
    );
    expect(reviews.rowCount).toBe(1);
    expect(reviews.rows[0].project_id).toBe(projectId);
  });

  it('completing the last non-verifier item auto-enqueues the DoD verifier', async () => {
    const { projectId, planId, codeWorkIds } = await setupProjectWithPlanAndCode();
    await client.call('complete_work', { id: codeWorkIds[0] });
    await client.call('complete_work', { id: codeWorkIds[1] });
    // Per-plan review now exists; complete it.
    const review = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE plan_id=$1 AND type='review' AND is_dod_verifier=false`,
      [planId],
    );
    await client.call('complete_work', { id: review.rows[0].id });
    const verifiers = await db.pool.query<{ id: number; type: string; is_dod_verifier: boolean }>(
      `SELECT id, type, is_dod_verifier FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rowCount).toBe(1);
    expect(verifiers.rows[0].type).toBe('review');
  });

  it('completing the DoD verifier flips the project to done', async () => {
    const { projectId, planId, codeWorkIds } = await setupProjectWithPlanAndCode();
    await client.call('complete_work', { id: codeWorkIds[0] });
    await client.call('complete_work', { id: codeWorkIds[1] });
    const review = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE plan_id=$1 AND type='review' AND is_dod_verifier=false`,
      [planId],
    );
    await client.call('complete_work', { id: review.rows[0].id });
    const verifier = await db.pool.query<{ id: number }>(
      `SELECT id FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    await client.call('complete_work', { id: verifier.rows[0].id });
    const proj = await db.pool.query<{ status: string }>(
      `SELECT status FROM projects WHERE id=$1`,
      [projectId],
    );
    expect(proj.rows[0].status).toBe('done');
  });

  it('triggers do not fire while project is blocked, and replay on unblock', async () => {
    const { projectId, planId, codeWorkIds } = await setupProjectWithPlanAndCode();
    await client.call('block_project', { id: projectId, reason: 'paused' });
    await client.call('complete_work', { id: codeWorkIds[0] });
    await client.call('complete_work', { id: codeWorkIds[1] });
    let reviews = await db.pool.query(
      `SELECT count(*)::int AS n FROM work_items WHERE plan_id=$1 AND type='review'`,
      [planId],
    );
    expect(reviews.rows[0].n).toBe(0);
    await client.call('unblock_project', { id: projectId });
    reviews = await db.pool.query(
      `SELECT count(*)::int AS n FROM work_items WHERE plan_id=$1 AND type='review'`,
      [planId],
    );
    expect(reviews.rows[0].n).toBe(1);
  });
});
