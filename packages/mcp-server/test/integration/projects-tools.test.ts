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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
