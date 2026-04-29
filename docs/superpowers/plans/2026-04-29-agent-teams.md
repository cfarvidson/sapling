# Agent Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class **teams** (lead + specialist roles) to Sapling so a work item can be executed by a coordinated team of agents instead of a solo agent. Lead is what the runner spawns; specialists are dispatched in-process via Claude Code's `Agent` tool. Solo execution remains the unchanged default.

**Architecture:** Two new tables (`teams`, `team_roles`) plus `team_defaults` and a nullable `work_items.team_id` column. Ten new MCP CRUD tools. `enqueue_work` resolves `team_id` once at insert time using a fixed precedence chain (explicit → app+type default → global+type default → null). `/sapling:work` reads `team_id` after claiming and switches to "lead mode" — solo mode is preserved. The runner package and `claim_next_work` are untouched.

**Tech Stack:** Node 20, TypeScript, `pg` (node-postgres), `@modelcontextprotocol/sdk`, `zod`, Vitest with testcontainers Postgres. Postgres 16 (uses `UNIQUE NULLS NOT DISTINCT`, PG 15+).

**Spec:** `docs/superpowers/specs/2026-04-29-agent-teams-design.md`

---

## File Structure

**Create:**

- `packages/mcp-server/src/schema/006_teams.sql` — migration adding `teams`, `team_roles`, `team_defaults`, and `work_items.team_id`.
- `packages/mcp-server/src/tools/teams.ts` — registers 10 MCP tools (team CRUD, role CRUD, defaults CRUD).
- `packages/mcp-server/test/integration/teams.test.ts` — CRUD + cascade behavior tests.
- `packages/mcp-server/test/integration/enqueue-team-resolution.test.ts` — focused tests for the enqueue resolution chain.
- `packages/claude-plugin/skills/teams/SKILL.md` — `/sapling:teams` skill.

**Modify:**

- `packages/mcp-server/src/tools/work.ts` — add `team_id` to `enqueue_work` (with resolution chain); add `LEFT JOIN teams` to `list_work` so each row carries `team_name`.
- `packages/mcp-server/src/tools/register.ts` — register team tools.
- `packages/claude-plugin/skills/work/SKILL.md` — insert step 4b (load team in lead mode if `team_id` set).
- `packages/claude-plugin/skills/enqueue/SKILL.md` — parse optional `team <name>` token; pass `team_id`.
- `packages/claude-plugin/skills/plan/SKILL.md` — parse optional `team <name>` token; pass `team_id`.
- `packages/claude-plugin/skills/status/SKILL.md` — surface `team_name` next to claimed/pending rows.
- `packages/claude-plugin/skills/queue/SKILL.md` — surface `team_name` in overview rows and `work <id>` detail.
- `README.md` — update tool count (26 → 36); add a "Teams" section.

---

## Task 1: Schema migration

**Files:**

- Create: `packages/mcp-server/src/schema/006_teams.sql`
- Test: `packages/mcp-server/test/integration/teams.test.ts` (just enough to verify the migration applies)

- [ ] **Step 1: Write the failing test (migration smoke)**

Create `packages/mcp-server/test/integration/teams.test.ts` with this content (it will grow throughout the plan):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: FAILS — `relation "teams" does not exist` (or similar). The migration hasn't been written.

- [ ] **Step 3: Write the migration**

Create `packages/mcp-server/src/schema/006_teams.sql`:

```sql
CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  app_id         INT REFERENCES apps(id) ON DELETE CASCADE,
  description    TEXT,
  lead_prompt_md TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (app_id, name)
);

CREATE TABLE IF NOT EXISTS team_roles (
  id             SERIAL PRIMARY KEY,
  team_id        INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description_md TEXT NOT NULL,
  subagent_type  TEXT,
  ordinal        INT NOT NULL DEFAULT 0,
  UNIQUE (team_id, name)
);

CREATE TABLE IF NOT EXISTS team_defaults (
  id        SERIAL PRIMARY KEY,
  app_id    INT REFERENCES apps(id) ON DELETE CASCADE,
  work_type work_type NOT NULL,
  team_id   INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT team_defaults_uniq UNIQUE NULLS NOT DISTINCT (app_id, work_type)
);

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS work_team_idx ON work_items (team_id) WHERE team_id IS NOT NULL;
```

Note: `UNIQUE NULLS NOT DISTINCT` requires Postgres 15+. Sapling pins `postgres:16-alpine` (see `docker-compose.yml`), so this is fine. The `team_defaults_uniq` constraint name is referenced by `set_team_default`'s `ON CONFLICT ON CONSTRAINT` clause in Task 5 — keep it exactly as written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All three tests in the schema describe block PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/schema/006_teams.sql packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): teams schema (migration 006)"
```

---

## Task 2: `create_team` and `get_team` tools

**Files:**

- Create: `packages/mcp-server/src/tools/teams.ts`
- Modify: `packages/mcp-server/src/tools/register.ts` (register the new module)
- Test: `packages/mcp-server/test/integration/teams.test.ts` (append a new describe block)

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `packages/mcp-server/test/integration/teams.test.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: FAILS — `tool create_team returned error: ... method not found` (or similar). The tools aren't registered yet.

- [ ] **Step 3: Implement `create_team` and `get_team`**

Create `packages/mcp-server/src/tools/teams.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const RoleInput = z.object({
  name: z.string().min(1),
  description_md: z.string().min(1),
  subagent_type: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative().optional(),
});

async function loadTeamWithRoles(db: Db, id: number): Promise<Record<string, unknown> | null> {
  const t = await db.query(`SELECT * FROM teams WHERE id = $1`, [id]);
  if (t.rowCount === 0) return null;
  const r = await db.query(
    `SELECT * FROM team_roles WHERE team_id = $1 ORDER BY ordinal ASC, id ASC`,
    [id],
  );
  return { ...t.rows[0], roles: r.rows };
}

export function registerTeams(server: McpServer, db: Db): void {
  server.registerTool(
    'create_team',
    {
      description:
        'Create a team and its initial roles in one call. Set app_id to scope the team to one app, or omit for a global team.',
      inputSchema: {
        name: z.string().min(1),
        app_id: z.number().int().positive().optional(),
        description: z.string().optional(),
        lead_prompt_md: z.string().min(1),
        roles: z.array(RoleInput).min(1),
      },
    },
    async (input) => {
      const client = await db.connect();
      let teamId: number;
      try {
        await client.query('BEGIN');
        const team = await client.query(
          `INSERT INTO teams(name, app_id, description, lead_prompt_md)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.name, input.app_id ?? null, input.description ?? null, input.lead_prompt_md],
        );
        teamId = (team.rows[0] as { id: number }).id;
        for (const role of input.roles) {
          await client.query(
            `INSERT INTO team_roles(team_id, name, description_md, subagent_type, ordinal)
             VALUES ($1, $2, $3, $4, $5)`,
            [teamId, role.name, role.description_md, role.subagent_type ?? null, role.ordinal ?? 0],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
      client.release();
      const full = await loadTeamWithRoles(db, teamId);
      return ok(full);
    },
  );

  server.registerTool(
    'get_team',
    {
      description:
        'Fetch a team by id, or by (name, app_id?). When looking up by name, omit app_id (or pass null) for the global team.',
      inputSchema: z
        .object({
          id: z.number().int().positive().optional(),
          name: z.string().min(1).optional(),
          app_id: z.number().int().positive().nullable().optional(),
        })
        .refine((v) => v.id !== undefined || v.name !== undefined, {
          message: 'must provide id or name',
        }),
    },
    async (input) => {
      let id = input.id;
      if (id === undefined) {
        const { rows } = input.app_id
          ? await db.query(`SELECT id FROM teams WHERE name = $1 AND app_id = $2`, [
              input.name,
              input.app_id,
            ])
          : await db.query(`SELECT id FROM teams WHERE name = $1 AND app_id IS NULL`, [input.name]);
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `team ${input.name} not found`));
        id = (rows[0] as { id: number }).id;
      }
      const full = await loadTeamWithRoles(db, id);
      if (!full) return errorToToolResult(new AppError('not_found', `team ${id} not found`));
      return ok(full);
    },
  );
}
```

Modify `packages/mcp-server/src/tools/register.ts` to wire it up:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { registerArtifacts } from './artifacts.js';
import { registerHumanInput } from './human_input.js';
import { registerPlans } from './plans.js';
import { registerProducts, registerServiceTools } from './products.js';
import { registerRunnerConfig } from './runner_config.js';
import { registerTeams } from './teams.js';
import { registerWork, registerWorkClaim, registerWorkLifecycle } from './work.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
  registerServiceTools(server, db);
  registerPlans(server, db);
  registerWork(server, db);
  registerWorkClaim(server, db);
  registerWorkLifecycle(server, db);
  registerArtifacts(server, db);
  registerRunnerConfig(server, db);
  registerHumanInput(server, db);
  registerTeams(server, db);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All five tests in the new describe block PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/teams.ts packages/mcp-server/src/tools/register.ts packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): create_team + get_team tools"
```

---

## Task 3: `list_teams`, `update_team`, `delete_team`

**Files:**

- Modify: `packages/mcp-server/src/tools/teams.ts`
- Test: `packages/mcp-server/test/integration/teams.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `teams.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All five new tests FAIL — tools not registered.

- [ ] **Step 3: Implement the three tools**

Append to `packages/mcp-server/src/tools/teams.ts` (inside the existing `registerTeams` function, after the `get_team` registration):

```ts
server.registerTool(
  'list_teams',
  {
    description:
      'List teams with role counts. Filter by app_id or app_name to scope to one app (use neither to see global + all apps).',
    inputSchema: {
      app_id: z.number().int().positive().optional(),
      app_name: z.string().min(1).optional(),
    },
  },
  async ({ app_id, app_name }) => {
    let resolved: number | null = app_id ?? null;
    if (resolved === null && app_name) {
      const lookup = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
        app_name,
      ]);
      if (lookup.rowCount === 0)
        return errorToToolResult(new AppError('not_found', `app ${app_name} not found`));
      resolved = lookup.rows[0].id;
    }
    const where = resolved !== null ? `WHERE t.app_id = $1` : '';
    const args = resolved !== null ? [resolved] : [];
    const { rows } = await db.query(
      `SELECT t.*, COALESCE(rc.role_count, 0)::int AS role_count
         FROM teams t
         LEFT JOIN (
           SELECT team_id, COUNT(*) AS role_count FROM team_roles GROUP BY team_id
         ) rc ON rc.team_id = t.id
         ${where}
         ORDER BY t.app_id NULLS FIRST, t.name ASC`,
      args,
    );
    return ok(rows);
  },
);

server.registerTool(
  'update_team',
  {
    description:
      'Patch any subset of team scalar fields (name, app_id, description, lead_prompt_md). Roles are managed via add_team_role / update_team_role / remove_team_role.',
    inputSchema: {
      id: z.number().int().positive(),
      name: z.string().min(1).optional(),
      app_id: z.number().int().positive().nullable().optional(),
      description: z.string().nullable().optional(),
      lead_prompt_md: z.string().min(1).optional(),
    },
  },
  async ({ id, ...patch }) => {
    const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(
      (k) => patch[k] !== undefined,
    );
    if (fields.length === 0)
      return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const f of fields) {
      sets.push(`${f} = $${i++}`);
      values.push(patch[f]);
    }
    sets.push(`updated_at = now()`);
    values.push(id);
    try {
      const { rows } = await db.query(
        `UPDATE teams SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `team ${id} not found`));
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);

server.registerTool(
  'delete_team',
  {
    description:
      'Hard delete a team. Cascades to team_roles and team_defaults. work_items.team_id on referencing items is set to NULL (those items revert to solo execution).',
    inputSchema: { id: z.number().int().positive() },
  },
  async ({ id }) => {
    const { rows } = await db.query(`DELETE FROM teams WHERE id = $1 RETURNING id`, [id]);
    if (rows.length === 0)
      return errorToToolResult(new AppError('not_found', `team ${id} not found`));
    return ok({ id });
  },
);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All ten teams-tool tests PASS (the five from Task 2 plus the five new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/teams.ts packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): list_teams, update_team, delete_team"
```

---

## Task 4: Role-management tools

**Files:**

- Modify: `packages/mcp-server/src/tools/teams.ts`
- Test: `packages/mcp-server/test/integration/teams.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `teams.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: Four new tests FAIL.

- [ ] **Step 3: Implement the three tools**

Append to `packages/mcp-server/src/tools/teams.ts` inside `registerTeams`:

```ts
server.registerTool(
  'add_team_role',
  {
    description: 'Add a single role to an existing team.',
    inputSchema: {
      team_id: z.number().int().positive(),
      name: z.string().min(1),
      description_md: z.string().min(1),
      subagent_type: z.string().min(1).optional(),
      ordinal: z.number().int().nonnegative().optional(),
    },
  },
  async (input) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO team_roles(team_id, name, description_md, subagent_type, ordinal)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          input.team_id,
          input.name,
          input.description_md,
          input.subagent_type ?? null,
          input.ordinal ?? 0,
        ],
      );
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);

server.registerTool(
  'update_team_role',
  {
    description: 'Patch a team role.',
    inputSchema: {
      id: z.number().int().positive(),
      name: z.string().min(1).optional(),
      description_md: z.string().min(1).optional(),
      subagent_type: z.string().min(1).nullable().optional(),
      ordinal: z.number().int().nonnegative().optional(),
    },
  },
  async ({ id, ...patch }) => {
    const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(
      (k) => patch[k] !== undefined,
    );
    if (fields.length === 0)
      return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const f of fields) {
      sets.push(`${f} = $${i++}`);
      values.push(patch[f]);
    }
    values.push(id);
    try {
      const { rows } = await db.query(
        `UPDATE team_roles SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `team_role ${id} not found`));
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);

server.registerTool(
  'remove_team_role',
  {
    description: 'Delete a team role by id.',
    inputSchema: { id: z.number().int().positive() },
  },
  async ({ id }) => {
    const { rows } = await db.query(`DELETE FROM team_roles WHERE id = $1 RETURNING id`, [id]);
    if (rows.length === 0)
      return errorToToolResult(new AppError('not_found', `team_role ${id} not found`));
    return ok({ id });
  },
);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All four new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/teams.ts packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): team role CRUD tools"
```

---

## Task 5: `set_team_default` and `clear_team_default`

**Files:**

- Modify: `packages/mcp-server/src/tools/teams.ts`
- Test: `packages/mcp-server/test/integration/teams.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `teams.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: Four new tests FAIL.

- [ ] **Step 3: Implement the two tools**

Append to `packages/mcp-server/src/tools/teams.ts` inside `registerTeams`:

```ts
const WorkTypeForDefault = z.enum(['plan', 'code', 'review']);

server.registerTool(
  'set_team_default',
  {
    description:
      'Upsert the default team for (app_id, work_type). Pass app_id to scope per app, or omit for the global default.',
    inputSchema: {
      work_type: WorkTypeForDefault,
      team_id: z.number().int().positive(),
      app_id: z.number().int().positive().optional(),
    },
  },
  async ({ work_type, team_id, app_id }) => {
    try {
      const { rows } = app_id
        ? await db.query(
            `INSERT INTO team_defaults(app_id, work_type, team_id)
             VALUES ($1, $2, $3)
             ON CONFLICT ON CONSTRAINT team_defaults_uniq
             DO UPDATE SET team_id = EXCLUDED.team_id
             RETURNING *`,
            [app_id, work_type, team_id],
          )
        : await db.query(
            `INSERT INTO team_defaults(app_id, work_type, team_id)
             VALUES (NULL, $1, $2)
             ON CONFLICT ON CONSTRAINT team_defaults_uniq
             DO UPDATE SET team_id = EXCLUDED.team_id
             RETURNING *`,
            [work_type, team_id],
          );
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);

server.registerTool(
  'clear_team_default',
  {
    description:
      'Remove a default. Pass app_id to clear a per-app default; omit for the global default.',
    inputSchema: {
      work_type: WorkTypeForDefault,
      app_id: z.number().int().positive().optional(),
    },
  },
  async ({ work_type, app_id }) => {
    const { rows } = app_id
      ? await db.query(
          `DELETE FROM team_defaults WHERE app_id = $1 AND work_type = $2 RETURNING id`,
          [app_id, work_type],
        )
      : await db.query(
          `DELETE FROM team_defaults WHERE app_id IS NULL AND work_type = $1 RETURNING id`,
          [work_type],
        );
    if (rows.length === 0)
      return errorToToolResult(new AppError('not_found', `no default to clear`));
    return ok({ cleared: true });
  },
);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: All four new tests PASS. The full `teams.test.ts` suite passes (~18 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/teams.ts packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): team_defaults set/clear tools"
```

---

## Task 6: `enqueue_work` accepts `team_id` and resolves defaults

**Files:**

- Modify: `packages/mcp-server/src/tools/work.ts:21-58` (the `enqueue_work` registration block)
- Create: `packages/mcp-server/test/integration/enqueue-team-resolution.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/integration/enqueue-team-resolution.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sapling/mcp-server test -- enqueue-team-resolution`
Expected: All six tests FAIL — `enqueue_work` does not accept or store `team_id`.

- [ ] **Step 3: Modify `enqueue_work`**

Open `packages/mcp-server/src/tools/work.ts`. Replace the entire `enqueue_work` registration (currently lines 22–59) with this version. Note the new `team_id` input field, the resolution helper, and the app-scope validation:

```ts
server.registerTool(
  'enqueue_work',
  {
    description:
      'Add a typed task to the queue (plan / code / review). team_id resolution: explicit value > per-app default for (service.app_id, type) > global default for (NULL, type) > null (solo agent).',
    inputSchema: {
      type: WorkType,
      title: z.string().min(1),
      description_markdown: z.string(),
      priority: z.number().int().default(0),
      service_id: z.number().int().positive().optional(),
      plan_id: z.number().int().positive().optional(),
      branch: z.string().optional(),
      pr_url: z.string().url().optional(),
      team_id: z.number().int().positive().optional(),
    },
  },
  async (input) => {
    try {
      let appId: number | null = null;
      if (input.service_id) {
        const svc = await db.query<{ app_id: number | null }>(
          `SELECT app_id FROM services WHERE id = $1`,
          [input.service_id],
        );
        if (svc.rowCount === 0)
          return errorToToolResult(
            new AppError('not_found', `service ${input.service_id} not found`),
          );
        appId = svc.rows[0].app_id;
      }

      let teamId: number | null = null;
      if (input.team_id !== undefined) {
        const t = await db.query<{ app_id: number | null }>(
          `SELECT app_id FROM teams WHERE id = $1`,
          [input.team_id],
        );
        if (t.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `team ${input.team_id} not found`));
        const teamApp = t.rows[0].app_id;
        if (teamApp !== null && appId !== null && teamApp !== appId) {
          return errorToToolResult(
            new AppError(
              'invalid_input',
              `team ${input.team_id} is scoped to app ${teamApp} but service belongs to app ${appId}`,
            ),
          );
        }
        teamId = input.team_id;
      } else {
        // Resolution chain: per-app default → global default → null.
        if (appId !== null) {
          const perApp = await db.query<{ team_id: number }>(
            `SELECT team_id FROM team_defaults WHERE app_id = $1 AND work_type = $2`,
            [appId, input.type],
          );
          if (perApp.rowCount > 0) teamId = perApp.rows[0].team_id;
        }
        if (teamId === null) {
          const global = await db.query<{ team_id: number }>(
            `SELECT team_id FROM team_defaults WHERE app_id IS NULL AND work_type = $1`,
            [input.type],
          );
          if (global.rowCount > 0) teamId = global.rows[0].team_id;
        }
      }

      const { rows } = await db.query(
        `INSERT INTO work_items
           (type, title, description_markdown, priority, service_id, plan_id, branch, pr_url, team_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          input.type,
          input.title,
          input.description_markdown,
          input.priority,
          input.service_id ?? null,
          input.plan_id ?? null,
          input.branch ?? null,
          input.pr_url ?? null,
          teamId,
        ],
      );
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sapling/mcp-server test -- enqueue-team-resolution`
Expected: All six tests PASS. Then run the full suite to make sure no existing tests broke:

```bash
pnpm --filter @sapling/mcp-server test
```

Expected: every existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/work.ts packages/mcp-server/test/integration/enqueue-team-resolution.test.ts
git commit -m "feat(mcp-server): enqueue_work resolves team_id from explicit/default chain"
```

---

## Task 7: `list_work` surfaces `team_name`

**Files:**

- Modify: `packages/mcp-server/src/tools/work.ts:75-131` (the `list_work` registration)
- Test: extend `packages/mcp-server/test/integration/teams.test.ts` with one assertion

- [ ] **Step 1: Write the failing test**

Append to `teams.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Expected: New test FAILS — `team_name` is undefined on rows.

- [ ] **Step 3: Modify `list_work`**

Open `packages/mcp-server/src/tools/work.ts`. In the `list_work` handler, change the SQL block to add the `LEFT JOIN teams` and project `team_name`. Replace the `db.query(...)` call inside `list_work` with:

```ts
const { rows } = await db.query(
  `SELECT w.*, s.app_id AS app_id, a.name AS app_name, tm.name AS team_name
     FROM work_items w
     LEFT JOIN services s ON s.id = w.service_id
     LEFT JOIN apps a ON a.id = s.app_id
     LEFT JOIN teams tm ON tm.id = w.team_id
     ${where}
     ORDER BY a.name NULLS LAST, w.priority DESC, w.created_at ASC`,
  vals,
);
```

Also update the tool's `description` field to mention `team_name`:

```ts
description:
  'List work items with optional filters. Each row includes app_id, app_name, and team_name (NULL if no team assigned).',
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sapling/mcp-server test -- teams.test`
Then: `pnpm --filter @sapling/mcp-server test`
Expected: New test PASSES, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/work.ts packages/mcp-server/test/integration/teams.test.ts
git commit -m "feat(mcp-server): list_work surfaces team_name via LEFT JOIN"
```

---

## Task 8: `/sapling:teams` skill

**Files:**

- Create: `packages/claude-plugin/skills/teams/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `packages/claude-plugin/skills/teams/SKILL.md`:

````markdown
---
name: teams
description: Manage agent teams in Sapling — create teams, manage roles, set per-(app, work_type) defaults that auto-attach a team to new work items. Triggers on /sapling:teams.
---

# /sapling:teams

A **team** is a named bundle of role definitions. When attached to a work item (via `team_id`), `/sapling:work` switches into "lead mode": the agent that the runner spawns prepends the team's `lead_prompt_md` to its instructions and dispatches specialists via Claude's `Agent` tool when the work demands it. Items without a team run as solo agents (current behavior).

Teams are stored server-side. They have an optional `app_id` so you can have global teams (`app_id = NULL`) and per-app overrides with the same name.

## Forms

```
/sapling:teams                                      — list every team, grouped by app
/sapling:teams <name> [app <app>]                   — show one team + its roles + lead prompt
/sapling:teams create <name> [app <app>]            — interactive: collect lead prompt + initial roles
/sapling:teams update <name> [app <app>]            — interactive: edit description / lead prompt / app scope
/sapling:teams remove <name> [app <app>]            — delete the team (work items revert to solo)

/sapling:teams <name> [app <app>] add-role <role>   — interactive: collect description, optional subagent_type
/sapling:teams <name> [app <app>] update-role <role>— interactive: edit description / subagent_type / ordinal
/sapling:teams <name> [app <app>] remove-role <role>— delete one role

/sapling:teams set-default <work_type> <team> [app <app>]
                                                    — auto-attach <team> to new <work_type> items in that scope
/sapling:teams clear-default <work_type> [app <app>]
                                                    — remove a default
```

`<work_type>` is one of `plan`, `code`, `review`.

## Steps

### Overview (no args)

1. `mcp__sapling__list_teams({})` — returns every team plus `role_count`.
2. Group by `app_id` (treat NULL as `(global)`). Sort apps alphabetically; `(global)` first. For each group:

   ```
   GLOBAL TEAMS
     code-review        (id 3)  3 roles
     plan-board         (id 5)  4 roles
   APP TEAMS — iris
     code-review        (id 7)  4 roles  ← shadows global "code-review" for iris items
   ```

3. Below the list, render the **defaults** by querying `mcp__sapling__list_teams` and joining against the `team_defaults` table is not exposed as a tool — instead, infer defaults by attempting `get_team` lookups isn't necessary either. Skip the defaults summary in the overview; users can see the active default for an item from `/sapling:queue work <id>` (which shows `team_name`). Footer:

   ```
   Run /sapling:teams <name> to inspect, or /sapling:teams create <name> to add a new one.
   ```

### Show one (`<name> [app <app>]`)

1. Resolve `app_id`:
   - If `app <app>` is present, `mcp__sapling__get_app({ name: <app> })` → `app.id`.
   - Else `app_id = null` (global).
2. `mcp__sapling__get_team({ name, app_id })`. If `not_found`, tell the user there is no `<name>` team in that scope and suggest `create`.
3. Print:

   ```
   ## <name>            (id <id>, app=<app or global>)
   <description (or "—")>

   LEAD PROMPT
   <lead_prompt_md>

   ROLES (in dispatch-list order)
     - <role.name>   subagent_type=<role.subagent_type or general-purpose>
       <role.description_md>
   ```

### Create (`create <name> [app <app>]`)

1. Resolve `app_id` as above.
2. Ask the user (in chat) for:
   - `description` (one-liner, optional)
   - `lead_prompt_md` (multi-line markdown — what should the lead emphasize? what's the team's posture?)
   - `roles`: collect at least one. For each, ask for `name`, `description_md` (when to invoke this specialist + what to prompt them with), and optionally `subagent_type` (a fully qualified Claude Code subagent identifier; leave blank for `general-purpose`).
3. Confirm the full body back to the user, then call `mcp__sapling__create_team({ name, app_id, description, lead_prompt_md, roles })`.
4. Tell the user the new id and offer: "Want me to set this as the default team for `<work_type>` items? (`/sapling:teams set-default …`)"

### Update (`update <name> [app <app>]`)

1. `get_team` to load current state. Print the current values.
2. Ask which fields to change. Call `mcp__sapling__update_team({ id, ...patch })` with only the changed fields.
3. Confirm with the new full body.

### Remove (`remove <name> [app <app>]`)

1. `get_team` first to confirm it exists. Look up referencing work items: `mcp__sapling__list_work({})` and filter by `team_name`. If any non-terminal items reference it, list them and ask "These will revert to solo agent. Continue?" before proceeding.
2. `mcp__sapling__delete_team({ id })`. Confirm.

### Role actions

- `add-role <role>`: `mcp__sapling__add_team_role({ team_id, name, description_md, subagent_type?, ordinal? })`. Ask the user for description, optional subagent_type, and ordinal (default 0).
- `update-role <role>`: resolve role id by re-fetching the team (`get_team`) and matching `name`. Then `mcp__sapling__update_team_role({ id, ...patch })`.
- `remove-role <role>`: same id resolution. `mcp__sapling__remove_team_role({ id })`.

### Defaults

- `set-default <work_type> <team> [app <app>]`:
  1. Resolve `team_id` via `get_team({ name: <team>, app_id })`.
  2. Resolve `app_id` for the default scope (separate from the team's scope — you can attach a global team as the default for one app).
  3. `mcp__sapling__set_team_default({ work_type, team_id, app_id? })`.
- `clear-default <work_type> [app <app>]`: `mcp__sapling__clear_team_default({ work_type, app_id? })`. Refuse gracefully (`not_found`) if there is no matching row.

## Notes

- A team's `app_id` and a default's `app_id` are independent. A global team (`team.app_id = NULL`) can be set as the default for app `iris` (`team_default.app_id = iris.id`); a per-app team can only be attached to work items whose service belongs to that same app (the server enforces this in `enqueue_work`).
- Defaults are resolved at enqueue time and stored on the work item. Changing a default later does not retroactively reroute pending items.
- When a team is deleted, referencing items have `work_items.team_id` set to `NULL` automatically — they revert to solo agent execution.
````

- [ ] **Step 2: Verify the skill is discoverable**

Run: `ls packages/claude-plugin/skills/teams/SKILL.md`
Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/teams/SKILL.md
git commit -m "feat(plugin): /sapling:teams skill"
```

---

## Task 9: `/sapling:work` step 4b — lead mode

**Files:**

- Modify: `packages/claude-plugin/skills/work/SKILL.md` (insert a new step between current step 4 and step 5)

- [ ] **Step 1: Open the file and locate the insertion point**

Open `packages/claude-plugin/skills/work/SKILL.md`. The insertion point is between current step 4 ("Load binding rules", line 54) and current step 5 ("Resume context", line 55). The new step is "4b" so existing step numbers don't shift.

- [ ] **Step 2: Insert step 4b**

Add this block immediately after the existing line 54 (the "Load binding rules" step), before the "Resume context" step:

````markdown
4b. **Load team (if assigned).** If the claimed work item has `team_id`, call `mcp__sapling__get_team({ id: team_id })`. The result is your team definition. Treat the rest of this work item as **lead mode**:

- Prepend `team.lead_prompt_md` to your operating instructions for this item. Treat it like a service convention — binding, not a suggestion.
- You have the following specialists available, in dispatch-list order:
  ```
  for role in team.roles:
    name=<role.name>
    description=<role.description_md>
    subagent_type=<role.subagent_type or "general-purpose">
  ```
- Dispatch a specialist via the `Agent` tool when the work demands it. Use `role.description_md` as the high-signal context for the specialist's prompt (combine it with the specific question/task). Use `role.subagent_type` if present; otherwise `general-purpose`.
- You remain the only writer to the filesystem and the only caller of `mcp__sapling__attach_artifact`, `mcp__sapling__complete_work`, and `mcp__sapling__request_human_input`. Specialists return text to you; you decide what to commit, what to attach as an artifact, and how to summarize.
- In your `complete_work` `summary_markdown`, mention which specialists you dispatched and what each contributed (one bullet per specialist is enough). This is the canonical record of team activity.
- If a specialist surfaces a question you cannot resolve, escalate via `mcp__sapling__request_human_input` exactly as solo mode would (the `$SAPLING_RUNNER` rule applies the same way — see the `type = 'plan'` section).

If `team_id` is null, skip this step entirely and continue in **solo mode** (everything below behaves as it always has).
````

- [ ] **Step 3: Verify the skill still parses (it's just markdown — visual check)**

Open the file and confirm the new step sits between the old step 4 and step 5, that the numbering reads `4. … 4b. … 5. …`, and that the indentation matches surrounding bullets.

- [ ] **Step 4: Commit**

```bash
git add packages/claude-plugin/skills/work/SKILL.md
git commit -m "feat(plugin): /sapling:work step 4b — lead mode for team work items"
```

---

## Task 10: `/sapling:enqueue` and `/sapling:plan` accept `team <name>`

**Files:**

- Modify: `packages/claude-plugin/skills/enqueue/SKILL.md`
- Modify: `packages/claude-plugin/skills/plan/SKILL.md`

- [ ] **Step 1: Update `/sapling:enqueue`**

Replace the contents of `packages/claude-plugin/skills/enqueue/SKILL.md` with:

````markdown
---
name: enqueue
description: Enqueue a code or review task in Sapling. Triggers on /sapling:enqueue <code|review> <description>.
---

# /sapling:enqueue

Enqueue a `code` or `review` work item.

## Steps

1. Parse arguments. Tokens:
   - First bareword: `code` or `review` (the work `type`).
   - Optional `team <name>` pair: pin a specific team to this item, overriding any default. `<name>` resolves against the work item's app scope (if a service is implied) — call `mcp__sapling__get_team({ name, app_id })` to get the id; on `not_found`, retry with `app_id` omitted (global team).
   - Everything else is the description.
2. If a service is implied, resolve via `mcp__sapling__list_services`.
3. For `review`, ask the user (if not provided) for `branch` and/or `pr_url`.
4. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "<code|review>",
  "title": "<short title>",
  "description_markdown": "<full description>",
  "service_id": <id if known>,
  "branch": "<if provided>",
  "pr_url": "<if provided>",
  "team_id": <id if `team <name>` was passed>
}
```

If `team_id` is omitted, the server applies the resolution chain: per-app default → global default → null (solo agent).

5. Confirm: "Queued <type> task #<id>." If a team was attached (explicit or via default), include "team=<team_name>" in the confirmation so the user can see what will run.
````

- [ ] **Step 2: Update `/sapling:plan`**

Replace the contents of `packages/claude-plugin/skills/plan/SKILL.md` with:

````markdown
---
name: plan
description: Quickly enqueue a planning task in Sapling. Triggers on /sapling:plan <description>.
---

# /sapling:plan

Enqueue a `plan`-type work item.

## Steps

1. Parse arguments:
   - Optional `team <name>` pair: pin a specific team. Resolve as in `/sapling:enqueue`.
   - Everything else is the description.
2. If a service is implied (mentioned by name), resolve it with `mcp__sapling__list_services` and grab its id.
3. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "plan",
  "title": "<short title derived from the description, max 80 chars>",
  "description_markdown": "<the full description from the user>",
  "service_id": <service id if known, otherwise omit>,
  "team_id": <id if `team <name>` was passed>
}
```

4. Tell the user: "Queued plan task #<id>. Run /sapling:work to start it." If a team was attached (explicit or via default), include "team=<team_name>" in the confirmation.
````

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/enqueue/SKILL.md packages/claude-plugin/skills/plan/SKILL.md
git commit -m "feat(plugin): /sapling:enqueue and /sapling:plan accept team <name> token"
```

---

## Task 11: `/sapling:status` and `/sapling:queue` surface `team_name`

**Files:**

- Modify: `packages/claude-plugin/skills/status/SKILL.md`
- Modify: `packages/claude-plugin/skills/queue/SKILL.md`

- [ ] **Step 1: Update `/sapling:status`**

In `packages/claude-plugin/skills/status/SKILL.md`, change the row format under "For each app, output:" so that `team` appears alongside `service`/`plan` when present. Replace this snippet:

```
   pending:
     #<id>  <type>  <title>          (service=<service_id> plan=<plan_id>)
```

with:

```
   pending:
     #<id>  <type>  <title>          (service=<service_id> plan=<plan_id> team=<team_name?>)
```

And add a sentence at the end of step 2 explaining the `team_name` field:

> Each row also carries `team_name` (NULL if no team is attached). When non-null, render it next to `service`/`plan` in parentheses; suppress the key entirely when null to keep output dense.

Apply the same `team=<team_name?>` addition to the `claimed:`, `awaiting_input:`, `blocked:`, and `failed:` rows shown in the example output block.

- [ ] **Step 2: Update `/sapling:queue`**

In `packages/claude-plugin/skills/queue/SKILL.md`:

1. In the **Overview** rendering example, change:

   ```
     #4  review     IRIS-1636: …                  service=32 plan=1
   ```

   to:

   ```
     #4  review     IRIS-1636: …                  service=32 plan=1 team=code-review
   ```

   Add a sentence after the example: "When a row's `team_name` is null (solo agent), suppress the `team=` key — show it only when set."

2. In the **`work <id>`** section, after "Print all fields.", add:

   > If `team_id` is set, also call `mcp__sapling__get_team({ id: team_id })` and print the team name, lead prompt header (first line), and role list. This makes it obvious what will run when the runner spawns this item.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/status/SKILL.md packages/claude-plugin/skills/queue/SKILL.md
git commit -m "feat(plugin): surface team_name in /sapling:status and /sapling:queue"
```

---

## Task 12: README — tool count + Teams section

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the tool count**

In `README.md`, find the line under "## Layout":

```
- `packages/mcp-server/` — Node/TypeScript MCP server (Streamable HTTP transport, 26 tools)
```

Change `26 tools` to `36 tools`.

- [ ] **Step 2: Add a Teams section**

Add a new section after "## Autonomous mode" and before "## Tests". Use this content:

````markdown
## Teams

A **team** lets one work item be executed by a coordinated lead + specialists instead of a solo agent. Teams are first-class rows: create them with `/sapling:teams`, optionally scope them to an app, and attach them to work items either explicitly or via per-(app, work_type) defaults.

```text
/sapling:teams                                  # list teams grouped by app
/sapling:teams create code-review               # interactive: lead prompt + roles
/sapling:teams set-default code code-review     # auto-attach to all new code items globally
/sapling:teams set-default code iris-code-review app iris  # per-app override
```

When the runner spawns `/sapling:work` for an item with `team_id`, the agent enters **lead mode**: it loads the team, prepends `lead_prompt_md` to its operating instructions, and dispatches specialists via Claude Code's `Agent` tool (with the role's `subagent_type` if pinned, else `general-purpose`). The lead remains the sole writer — specialists return text; the lead decides what gets committed.

A few invariants worth knowing:

- **Resolution is at enqueue time.** When you call `enqueue_work`, the server picks `team_id` once (explicit > per-app default > global default > null) and stores it on the row. Changing a default later does not retroactively reroute pending items.
- **`max_concurrent` semantics are unchanged.** A team is one process from the runner's point of view — the in-process specialists do not eat queue slots.
- **Solo mode is unchanged.** Items without `team_id` run exactly as they always have.
- **Deleting a team is non-destructive.** `work_items.team_id` is `ON DELETE SET NULL`, so referencing items revert to solo agent execution rather than failing.

See `docs/superpowers/specs/2026-04-29-agent-teams-design.md` for the full design rationale.
````

- [ ] **Step 3: Format and verify**

Run: `npx prettier --write README.md`
Expected: prettier reports no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — tool count 36, Teams section"
```

---

## Task 13: Final verification pass

- [ ] **Step 1: Run the full test suite**

Run: `pnpm --filter @sapling/mcp-server test`
Expected: all tests PASS, including the new `teams.test.ts` (~19 tests) and `enqueue-team-resolution.test.ts` (6 tests). No regressions.

- [ ] **Step 2: Run lint and prettier on changed code**

Run:

```bash
npx prettier --write packages/mcp-server/src/tools/teams.ts packages/mcp-server/src/tools/work.ts packages/mcp-server/src/tools/register.ts packages/mcp-server/src/schema/006_teams.sql packages/mcp-server/test/integration/teams.test.ts packages/mcp-server/test/integration/enqueue-team-resolution.test.ts packages/claude-plugin/skills/teams/SKILL.md packages/claude-plugin/skills/work/SKILL.md packages/claude-plugin/skills/enqueue/SKILL.md packages/claude-plugin/skills/plan/SKILL.md packages/claude-plugin/skills/status/SKILL.md packages/claude-plugin/skills/queue/SKILL.md README.md
pnpm lint
```

Expected: prettier writes no further changes; lint passes.

- [ ] **Step 3: Smoke-test end to end against a running server**

```bash
make up
# Wait for "running migrations" + "sapling mcp-server listening" in `make logs`.
```

In a Claude Code session with the Sapling plugin installed, run:

```text
/sapling:teams create test-team
# Walk through the interactive flow: lead prompt, one role.
/sapling:teams test-team
# Confirm the team renders correctly.
/sapling:teams set-default code test-team
/sapling:enqueue code "smoke test for team auto-attach"
/sapling:queue work <id>
# Confirm team=test-team is shown.
/sapling:teams remove test-team
# Confirm the work item's team_id reverts to NULL.
/sapling:queue work <id>
# Confirm no team= key appears now.
```

Expected: all steps succeed without errors; the work item flips between team and solo correctly.

- [ ] **Step 4: Commit only if there are formatting fixups**

```bash
git status
# If prettier or lint --fix made changes, stage them.
git add -p   # review hunks
git commit -m "chore: prettier/lint cleanup after teams feature"
```

If no changes, skip the commit.

---

## Summary of commits

After completing all tasks, the branch should have approximately the following commits (in order):

1. `feat(mcp-server): teams schema (migration 006)`
2. `feat(mcp-server): create_team + get_team tools`
3. `feat(mcp-server): list_teams, update_team, delete_team`
4. `feat(mcp-server): team role CRUD tools`
5. `feat(mcp-server): team_defaults set/clear tools`
6. `feat(mcp-server): enqueue_work resolves team_id from explicit/default chain`
7. `feat(mcp-server): list_work surfaces team_name via LEFT JOIN`
8. `feat(plugin): /sapling:teams skill`
9. `feat(plugin): /sapling:work step 4b — lead mode for team work items`
10. `feat(plugin): /sapling:enqueue and /sapling:plan accept team <name> token`
11. `feat(plugin): surface team_name in /sapling:status and /sapling:queue`
12. `docs: README — tool count 36, Teams section`
13. (optional) `chore: prettier/lint cleanup after teams feature`
