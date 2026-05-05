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
