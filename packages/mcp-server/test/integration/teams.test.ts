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

describe('teams tools — list / update / delete', () => {
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

  it('list_teams returns all teams with role_count, optionally filtered by app', async () => {
    await makeTeam('global');
    const app = (await client.call('register_app', { name: 'iris' })) as { id: number };
    await makeTeam('iris-team', app.id);
    const all = (await client.call('list_teams', {})) as Array<{
      name: string;
      role_count: number;
    }>;
    expect(all.map((t) => t.name).sort()).toEqual(['global', 'iris-team']);
    expect(all.every((t) => t.role_count === 1)).toBe(true);

    const onlyIris = (await client.call('list_teams', { app_name: 'iris' })) as Array<{
      name: string;
    }>;
    expect(onlyIris.map((t) => t.name)).toEqual(['iris-team']);
  });

  it('update_team patches scalars and leaves roles untouched', async () => {
    const created = await makeTeam('original');
    const updated = (await client.call('update_team', {
      id: created.id,
      name: 'renamed',
      description: 'new desc',
      lead_prompt_md: 'new lead',
    })) as { name: string; description: string; lead_prompt_md: string };
    expect(updated).toMatchObject({
      name: 'renamed',
      description: 'new desc',
      lead_prompt_md: 'new lead',
    });
  });

  it('update_team rejects empty patch', async () => {
    const created = await makeTeam('x');
    const raw = await client.callRaw('update_team', { id: created.id });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error.code).toBe('invalid_input');
  });

  it('delete_team removes the team and cascades to roles', async () => {
    const created = await makeTeam('to-delete');
    await client.call('delete_team', { id: created.id });
    const teams = await db.pool.query(`SELECT id FROM teams WHERE id = $1`, [created.id]);
    expect(teams.rowCount).toBe(0);
    const roles = await db.pool.query(`SELECT id FROM team_roles WHERE team_id = $1`, [created.id]);
    expect(roles.rowCount).toBe(0);
  });

  it('delete_team sets work_items.team_id to NULL on referencing items', async () => {
    const created = await makeTeam('soon-deleted');
    const work = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown, team_id)
       VALUES ('code', 't', 'd', $1) RETURNING id`,
      [created.id],
    );
    await client.call('delete_team', { id: created.id });
    const after = await db.pool.query<{ team_id: number | null }>(
      `SELECT team_id FROM work_items WHERE id = $1`,
      [work.rows[0].id],
    );
    expect(after.rows[0].team_id).toBeNull();
  });
});

describe('team_roles tools', () => {
  let db: TestDb;
  let client: TestClient;
  let teamId: number;

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
    const team = (await client.call('create_team', {
      name: 't',
      lead_prompt_md: 'lead',
      roles: [{ name: 'initial', description_md: 'd' }],
    })) as { id: number };
    teamId = team.id;
  });

  it('add_team_role appends a role and returns it', async () => {
    const role = (await client.call('add_team_role', {
      team_id: teamId,
      name: 'security',
      description_md: 'auth review',
      subagent_type: 'compound-engineering:review:security-reviewer',
      ordinal: 5,
    })) as { name: string; ordinal: number };
    expect(role).toMatchObject({
      name: 'security',
      ordinal: 5,
      subagent_type: 'compound-engineering:review:security-reviewer',
    });
  });

  it('add_team_role rejects duplicate name within a team', async () => {
    const raw = await client.callRaw('add_team_role', {
      team_id: teamId,
      name: 'initial',
      description_md: 'dup',
    });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error.code).toBe('conflict');
  });

  it('update_team_role patches scalars', async () => {
    const role = (await client.call('add_team_role', {
      team_id: teamId,
      name: 'r2',
      description_md: 'old',
    })) as { id: number };
    const updated = (await client.call('update_team_role', {
      id: role.id,
      description_md: 'new',
      ordinal: 9,
    })) as { description_md: string; ordinal: number };
    expect(updated).toMatchObject({ description_md: 'new', ordinal: 9 });
  });

  it('remove_team_role deletes by id', async () => {
    const role = (await client.call('add_team_role', {
      team_id: teamId,
      name: 'r3',
      description_md: 'd',
    })) as { id: number };
    await client.call('remove_team_role', { id: role.id });
    const left = await db.pool.query(`SELECT id FROM team_roles WHERE id = $1`, [role.id]);
    expect(left.rowCount).toBe(0);
  });
});

describe('team_defaults tools', () => {
  let db: TestDb;
  let client: TestClient;
  let teamId: number;

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
    const team = (await client.call('create_team', {
      name: 't',
      lead_prompt_md: 'lead',
      roles: [{ name: 'r', description_md: 'd' }],
    })) as { id: number };
    teamId = team.id;
  });

  it('set_team_default upserts a global default per work_type', async () => {
    const a = (await client.call('set_team_default', {
      work_type: 'code',
      team_id: teamId,
    })) as { app_id: number | null; work_type: string; team_id: number };
    expect(a).toMatchObject({ app_id: null, work_type: 'code', team_id: teamId });

    // Calling again with the same key updates the row, doesn't create a duplicate.
    await client.call('set_team_default', { work_type: 'code', team_id: teamId });
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM team_defaults WHERE app_id IS NULL AND work_type='code'`,
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('set_team_default supports per-app defaults distinct from globals', async () => {
    const app = (await client.call('register_app', { name: 'iris' })) as { id: number };
    await client.call('set_team_default', { work_type: 'code', team_id: teamId });
    await client.call('set_team_default', { work_type: 'code', team_id: teamId, app_id: app.id });
    const rows = await db.pool.query(
      `SELECT app_id FROM team_defaults WHERE work_type='code' ORDER BY app_id NULLS FIRST`,
    );
    expect(rows.rows.map((r) => r.app_id)).toEqual([null, app.id]);
  });

  it('clear_team_default removes the matching row', async () => {
    await client.call('set_team_default', { work_type: 'code', team_id: teamId });
    await client.call('clear_team_default', { work_type: 'code' });
    const rows = await db.pool.query(`SELECT id FROM team_defaults`);
    expect(rows.rowCount).toBe(0);
  });

  it('clear_team_default returns not_found when there is nothing to clear', async () => {
    const raw = await client.callRaw('clear_team_default', { work_type: 'code' });
    expect(raw.isError).toBe(true);
    expect(JSON.parse(raw.content[0].text).error.code).toBe('not_found');
  });
});

describe('list_work — team_name surfacing', () => {
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

  it('returns team_name on each row, NULL when no team is assigned', async () => {
    const team = (await client.call('create_team', {
      name: 'team-x',
      lead_prompt_md: 'lead',
      roles: [{ name: 'r', description_md: 'd' }],
    })) as { id: number };
    await client.call('enqueue_work', {
      type: 'code',
      title: 'with-team',
      description_markdown: 'd',
      team_id: team.id,
    });
    await client.call('enqueue_work', {
      type: 'code',
      title: 'solo',
      description_markdown: 'd',
    });
    const rows = (await client.call('list_work', {})) as Array<{
      title: string;
      team_name: string | null;
    }>;
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.team_name]));
    expect(byTitle['with-team']).toBe('team-x');
    expect(byTitle['solo']).toBeNull();
  });
});
