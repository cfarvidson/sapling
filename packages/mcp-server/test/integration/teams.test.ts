import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('teams schema (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
  });

  it('creates teams, team_roles, team_defaults tables and adds work_items.team_id', async () => {
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('teams','team_roles','team_defaults')`,
    );
    expect(new Set(tables.rows.map((r) => r.table_name))).toEqual(
      new Set(['teams', 'team_roles', 'team_defaults']),
    );

    const col = await db.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_items' AND column_name='team_id'`,
    );
    expect(col.rows[0]).toMatchObject({ column_name: 'team_id', is_nullable: 'YES' });
  });

  it('rejects two global teams with the same name (NULLS NOT DISTINCT)', async () => {
    await db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('global', 'lead')`);
    await expect(
      db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('global', 'lead')`),
    ).rejects.toThrow(/duplicate/i);
  });

  it('allows the same team name globally and per-app', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('iris')`);
    const app = await db.pool.query<{ id: number }>(`SELECT id FROM apps WHERE name='iris'`);
    await db.pool.query(`INSERT INTO teams(name, lead_prompt_md) VALUES ('code-review', 'g')`);
    await db.pool.query(
      `INSERT INTO teams(name, app_id, lead_prompt_md) VALUES ('code-review', $1, 'a')`,
      [app.rows[0].id],
    );
    const { rows } = await db.pool.query(`SELECT name, app_id FROM teams ORDER BY id`);
    expect(rows).toHaveLength(2);
  });
});

describe('teams tools — create / get', () => {
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

  it('create_team persists team + roles and returns the full row', async () => {
    const team = (await client.call('create_team', {
      name: 'code-review',
      description: 'lead + reviewer + tester',
      lead_prompt_md: 'You are the lead. Coordinate the team.',
      roles: [
        { name: 'reviewer', description_md: 'Read the diff and flag issues.' },
        {
          name: 'tester',
          description_md: 'Write tests that exercise the change.',
          subagent_type: 'general-purpose',
          ordinal: 1,
        },
      ],
    })) as { id: number; name: string; roles: Array<{ name: string }> };

    expect(team).toMatchObject({
      name: 'code-review',
      description: 'lead + reviewer + tester',
      app_id: null,
    });
    expect(team.roles.map((r) => r.name)).toEqual(['reviewer', 'tester']);
  });

  it('create_team scopes the team to an app when app_id is provided', async () => {
    const app = (await client.call('register_app', { name: 'iris' })) as { id: number };
    const team = (await client.call('create_team', {
      name: 'code-review',
      app_id: app.id,
      lead_prompt_md: 'iris-flavored lead',
      roles: [{ name: 'security', description_md: 'check auth.' }],
    })) as { app_id: number };
    expect(team.app_id).toBe(app.id);
  });

  it('create_team rejects when name already exists in the same scope', async () => {
    await client.call('create_team', {
      name: 'dup',
      lead_prompt_md: 'x',
      roles: [{ name: 'r', description_md: 'd' }],
    });
    const raw = await client.callRaw('create_team', {
      name: 'dup',
      lead_prompt_md: 'x',
      roles: [{ name: 'r', description_md: 'd' }],
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('conflict');
  });

  it('get_team accepts id or (name, app_id?) and returns roles ordered by ordinal then id', async () => {
    const created = (await client.call('create_team', {
      name: 'team-a',
      lead_prompt_md: 'lead',
      roles: [
        { name: 'b', description_md: 'b', ordinal: 2 },
        { name: 'a', description_md: 'a', ordinal: 1 },
      ],
    })) as { id: number };

    const byId = (await client.call('get_team', { id: created.id })) as {
      roles: Array<{ name: string }>;
    };
    expect(byId.roles.map((r) => r.name)).toEqual(['a', 'b']);

    const byName = (await client.call('get_team', { name: 'team-a' })) as { id: number };
    expect(byName.id).toBe(created.id);
  });

  it('get_team returns not_found for unknown id', async () => {
    const raw = await client.callRaw('get_team', { id: 9999 });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });
});
