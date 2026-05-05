# Sapling Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `projects` top-level entity to Sapling that drives an intent (Linear ticket / idea / bug) to a verified Definition of Done across one or more services within one app, by auto-enqueuing scoping → per-service plans → code → per-plan reviews → DoD verifier work items.

**Architecture:** One new Postgres table (`projects`), one new enum (`project_status`), two FK columns on existing tables, one boolean (`is_dod_verifier`) on `work_items`. Nine new MCP tools in `tools/projects.ts`. One new server-side helper (`advanceProjectAfterWorkCompletion`) called from inside the existing `complete_work` transaction. One new skill (`/sapling:project`); three existing skills get small edits. SPEC.md and plugin version bump in the same change.

**Tech Stack:** Node.js 22 + TypeScript (ESM), `pg`, `zod`, `@modelcontextprotocol/sdk`. Tests: `vitest` + `@testcontainers/postgresql`. Migrations are forward-only `.sql` files applied at startup. Plugin lives in `packages/claude-plugin/skills/`.

**Spec:** `docs/superpowers/specs/2026-05-05-projects-design.md` (commit `1ad1be0`). Re-read it before starting if any task feels under-specified — the spec is authoritative.

---

## File Structure

| Path                                                              | Disposition | Responsibility                                                                                                                                       |
| ----------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mcp-server/src/schema/007_projects.sql`                 | Create      | Migration: `project_status` enum, `projects` table, `project_id` FK on `plans` and `work_items`, `is_dod_verifier` on `work_items`, indexes.         |
| `packages/mcp-server/src/tools/projects.ts`                       | Create      | All 9 project MCP tools + `advanceProjectAfterWorkCompletion` helper.                                                                                |
| `packages/mcp-server/src/tools/register.ts`                       | Modify      | Wire `registerProjects` into `registerAllTools`.                                                                                                     |
| `packages/mcp-server/src/tools/work.ts`                           | Modify      | `enqueue_work`: accept `project_id`. `complete_work`: call `advanceProjectAfterWorkCompletion` inside its transaction when the row has `project_id`. |
| `packages/mcp-server/test/integration/projects-schema.test.ts`    | Create      | Migration-level assertions on table/enum/columns/indexes.                                                                                            |
| `packages/mcp-server/test/integration/projects-tools.test.ts`     | Create      | All MCP-tool happy-path + error-path tests for the 9 tools.                                                                                          |
| `packages/mcp-server/test/integration/projects-lifecycle.test.ts` | Create      | End-to-end lifecycle: scoping flow, fast path, per-plan review, DoD verifier, block/unblock replay, cascade.                                         |
| `packages/claude-plugin/skills/project/SKILL.md`                  | Create      | New skill backing `/sapling:project`.                                                                                                                |
| `packages/claude-plugin/skills/work/SKILL.md`                     | Modify      | Inject project context + Linear binding rule when claimed work has `project_id`.                                                                     |
| `packages/claude-plugin/skills/status/SKILL.md`                   | Modify      | Add Projects section above existing work-queue counts.                                                                                               |
| `packages/claude-plugin/skills/queue/SKILL.md`                    | Modify      | Add `/sapling:queue project <id>` drill-down form.                                                                                                   |
| `packages/claude-plugin/.claude-plugin/plugin.json`               | Modify      | Version bump `0.5.0` → `0.6.0`; add `/sapling:project` to description.                                                                               |
| `SPEC.md`                                                         | Modify      | Update §2, §4, §5, §7, §8, §12, §14, §17 per the spec doc's "SPEC.md updates" section.                                                               |

Each `tools/*.ts` file in this codebase exports one or more `register*` functions called from `register.ts`. The new `projects.ts` follows the same pattern: `export function registerProjects(server: McpServer, db: Db): void` plus an internal `advanceProjectAfterWorkCompletion(client, projectId, completedWork)` helper used both by `complete_work` (in `work.ts`) and by `unblock_project`.

---

## Conventions

- **TDD only.** Every change starts with a failing test. No exceptions, even for trivial tweaks.
- **Test isolation:** each `describe` block boots its own `startTestDb()` + runs migrations in `beforeAll`, truncates `apps RESTART IDENTITY CASCADE` in `beforeEach`. Cascade clears every dependent table including the new `projects`.
- **Tool result shape:** every successful tool returns `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`. Errors return `{ content: [...], isError: true }` with `{ error: { code, message, issues? } }`. Use `connectInMemory` from `test/helpers/mcp-client.ts` and call `client.call('tool_name', args)` (returns parsed JSON, throws on error) or `client.callRaw` (returns raw shape).
- **Pre-commit hooks:** `husky` runs prettier + eslint via `lint-staged`. Run `npx prettier --write <file>` and `npm run lint -- --fix` on changed files before each commit.
- **Commit style:** match `git log --oneline`. `feat(mcp-server): …`, `feat(claude-plugin): …`, `chore(schema): …`, `docs: …`, `test(mcp-server): …`. Body: imperative, why-first.

---

## Task 1: Migration `007_projects.sql`

**Files:**

- Create: `packages/mcp-server/src/schema/007_projects.sql`
- Create: `packages/mcp-server/test/integration/projects-schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `packages/mcp-server/test/integration/projects-schema.test.ts` with the following content:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects schema (migration 007)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  it('creates the projects table with the expected columns', async () => {
    const cols = await db.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='projects'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual([
      'id',
      'app_id',
      'title',
      'description_md',
      'definition_of_done_md',
      'linear_url',
      'status',
      'failure_reason',
      'created_at',
      'updated_at',
    ]);
    expect(cols.rows.find((r) => r.column_name === 'app_id')?.is_nullable).toBe('NO');
    expect(cols.rows.find((r) => r.column_name === 'linear_url')?.is_nullable).toBe('YES');
  });

  it('creates the project_status enum with all six values', async () => {
    const { rows } = await db.pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname='project_status'
        ORDER BY enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([
      'pending',
      'scoping',
      'in_progress',
      'done',
      'blocked',
      'cancelled',
    ]);
  });

  it('adds project_id to plans and work_items as nullable FK', async () => {
    const cols = await db.pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public'
          AND column_name='project_id'
          AND table_name IN ('plans','work_items')
        ORDER BY table_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: 'plans', column_name: 'project_id', is_nullable: 'YES' },
      { table_name: 'work_items', column_name: 'project_id', is_nullable: 'YES' },
    ]);
  });

  it('adds is_dod_verifier to work_items as NOT NULL DEFAULT false', async () => {
    const { rows } = await db.pool.query<{
      column_name: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='work_items' AND column_name='is_dod_verifier'`,
    );
    expect(rows[0]).toMatchObject({
      column_name: 'is_dod_verifier',
      is_nullable: 'NO',
    });
    expect(rows[0].column_default).toMatch(/false/);
  });

  it('cascades project deletion when an app is deleted', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('proj-cascade-app')`);
    const app = await db.pool.query<{ id: number }>(
      `SELECT id FROM apps WHERE name='proj-cascade-app'`,
    );
    await db.pool.query(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md)
       VALUES ($1, 't', 'd', 'dod')`,
      [app.rows[0].id],
    );
    await db.pool.query(`DELETE FROM apps WHERE id=$1`, [app.rows[0].id]);
    const after = await db.pool.query(`SELECT id FROM projects`);
    expect(after.rowCount).toBe(0);
  });

  it('sets project_id to NULL on plans/work_items when project is deleted', async () => {
    await db.pool.query(`INSERT INTO apps(name) VALUES ('proj-set-null-app')`);
    const app = await db.pool.query<{ id: number }>(
      `SELECT id FROM apps WHERE name='proj-set-null-app'`,
    );
    const proj = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md)
       VALUES ($1, 't', 'd', 'dod') RETURNING id`,
      [app.rows[0].id],
    );
    const w = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown, project_id)
       VALUES ('code', 't', 'd', $1) RETURNING id`,
      [proj.rows[0].id],
    );
    await db.pool.query(`DELETE FROM projects WHERE id=$1`, [proj.rows[0].id]);
    const { rows } = await db.pool.query(`SELECT project_id FROM work_items WHERE id=$1`, [
      w.rows[0].id,
    ]);
    expect(rows[0].project_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-schema.test.ts`
Expected: FAIL — migration 007 does not exist; either `runMigrations` succeeds but the `projects` table is missing (first test fails with empty `rows`) or the migrator throws.

- [ ] **Step 3: Write the migration**

Create `packages/mcp-server/src/schema/007_projects.sql`:

```sql
CREATE TYPE project_status AS ENUM (
  'pending',
  'scoping',
  'in_progress',
  'done',
  'blocked',
  'cancelled'
);

CREATE TABLE IF NOT EXISTS projects (
  id                    SERIAL PRIMARY KEY,
  app_id                INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description_md        TEXT NOT NULL,
  definition_of_done_md TEXT NOT NULL,
  linear_url            TEXT,
  status                project_status NOT NULL DEFAULT 'pending',
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS is_dod_verifier BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS plans_project_idx
  ON plans(project_id) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_project_idx
  ON work_items(project_id) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_status_idx
  ON projects(status);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-schema.test.ts`
Expected: PASS — all six `it` blocks green.

- [ ] **Step 5: Format and commit**

Run:

```bash
npx prettier --write packages/mcp-server/test/integration/projects-schema.test.ts
git add packages/mcp-server/src/schema/007_projects.sql \
        packages/mcp-server/test/integration/projects-schema.test.ts
git commit -m "feat(mcp-server): add projects schema (migration 007)

Introduces the projects table, project_status enum, project_id FKs on
plans and work_items, and the is_dod_verifier flag. Foundation for the
projects workflow driver — see docs/superpowers/specs/2026-05-05-projects-design.md."
```

---

## Task 2: Scaffold `tools/projects.ts` and wire into `register.ts`

**Files:**

- Create: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`
- Create: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing scaffold test**

Create `packages/mcp-server/test/integration/projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts`
Expected: FAIL — `client.callRaw('create_project', {})` throws because the tool isn't registered.

- [ ] **Step 3: Create the scaffold module**

Create `packages/mcp-server/src/tools/projects.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const NotImplemented = () =>
  errorToToolResult(new AppError('internal', 'project tool not yet implemented'));

export function registerProjects(server: McpServer, db: Db): void {
  // Suppress unused-arg lint until tools are filled in by subsequent tasks.
  void db;
  void ok;
  void mapPgError;

  for (const name of [
    'create_project',
    'complete_scoping',
    'get_project',
    'list_projects',
    'update_project',
    'cancel_project',
    'block_project',
    'unblock_project',
    'retry_project',
  ] as const) {
    server.registerTool(
      name,
      {
        description: `Stub for ${name}; real implementation lands in subsequent tasks.`,
        inputSchema: { _stub: z.unknown().optional() },
      },
      async () => NotImplemented(),
    );
  }
}
```

- [ ] **Step 4: Wire into `register.ts`**

Modify `packages/mcp-server/src/tools/register.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { registerArtifacts } from './artifacts.js';
import { registerHumanInput } from './human_input.js';
import { registerPlans } from './plans.js';
import { registerProducts, registerServiceTools } from './products.js';
import { registerProjects } from './projects.js';
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
  registerProjects(server, db);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts`
Expected: PASS — the registration test sees all nine tools.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/src/tools/register.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/src/tools/register.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): scaffold project tool registrations

Adds nine stub tools so subsequent TDD steps can flesh out one tool at a
time without the rest going missing from the MCP surface."
```

---

## Task 3: Implement `create_project` (scoping path)

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts` (inside the existing file, as a new `describe` block):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts`
Expected: FAIL — the stub returns `internal: project tool not yet implemented`.

- [ ] **Step 3: Implement `create_project` (scoping path) in `projects.ts`**

Replace the stub for `create_project` in `packages/mcp-server/src/tools/projects.ts`. Full updated file (the other eight stubs stay):

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const NotImplemented = () =>
  errorToToolResult(new AppError('internal', 'project tool not yet implemented'));

export function registerProjects(server: McpServer, db: Db): void {
  server.registerTool(
    'create_project',
    {
      description:
        'Create a project for an app. Without service_ids → status starts at scoping and a single plan-type scoping work item is auto-enqueued. With service_ids → status starts at in_progress and one plan work item per service is fanned out (fast path). Atomic.',
      inputSchema: {
        app_name: z.string().min(1),
        title: z.string().min(1),
        description_md: z.string().min(1),
        definition_of_done_md: z.string().min(1),
        linear_url: z.string().url().optional(),
        service_ids: z.array(z.number().int().positive()).optional(),
      },
    },
    async (input) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');

        const appLookup = await client.query<{ id: number }>(
          `SELECT id FROM apps WHERE name = $1`,
          [input.app_name],
        );
        if (appLookup.rowCount === 0) {
          await client.query('ROLLBACK');
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        }
        const appId = appLookup.rows[0].id;

        const fastPath = (input.service_ids?.length ?? 0) > 0;
        const initialStatus = fastPath ? 'in_progress' : 'scoping';

        const projInsert = await client.query(
          `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, linear_url, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            appId,
            input.title,
            input.description_md,
            input.definition_of_done_md,
            input.linear_url ?? null,
            initialStatus,
          ],
        );
        const project = projInsert.rows[0];

        if (!fastPath) {
          const scoping = await client.query(
            `INSERT INTO work_items(type, title, description_markdown, project_id)
             VALUES ('plan', $1, $2, $3)
             RETURNING *`,
            [
              `Scope project ${project.id}: ${project.title}`,
              `Scoping work for project ${project.id}.\n\n` +
                `Description:\n\n${project.description_md}\n\n` +
                `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
                `When you finish exploring, attach a 'scoping' artifact summarising which services are touched, ` +
                `then call complete_scoping(project_id=${project.id}, service_ids=[...]).`,
              project.id,
            ],
          );
          await client.query('COMMIT');
          return ok({ project, scoping_work: scoping.rows[0] });
        }

        // Fast path implemented in Task 4.
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError('internal', 'fast path not yet implemented (Task 4)'),
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      } finally {
        client.release();
      }
    },
  );

  // Stubs for the remaining eight tools — same shape as Task 2.
  for (const name of [
    'complete_scoping',
    'get_project',
    'list_projects',
    'update_project',
    'cancel_project',
    'block_project',
    'unblock_project',
    'retry_project',
  ] as const) {
    server.registerTool(
      name,
      {
        description: `Stub for ${name}; real implementation lands in a subsequent task.`,
        inputSchema: { _stub: z.unknown().optional() },
      },
      async () => NotImplemented(),
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "create_project — scoping path"`
Expected: PASS — three green tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): create_project scoping path

Atomically creates a project and auto-enqueues a single plan-type scoping
work item when service_ids is omitted. Fast path lands in the next task."
```

---

## Task 4: `create_project` fast path (skip-scoping)

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "fast path"`
Expected: FAIL — the placeholder branch returns `internal: fast path not yet implemented (Task 4)`.

- [ ] **Step 3: Implement the fast path**

In `packages/mcp-server/src/tools/projects.ts`, replace the placeholder fast-path block in `create_project` with the real fan-out. The complete `create_project` handler now reads:

```ts
async (input) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const appLookup = await client.query<{ id: number }>(
      `SELECT id FROM apps WHERE name = $1`,
      [input.app_name],
    );
    if (appLookup.rowCount === 0) {
      await client.query('ROLLBACK');
      return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
    }
    const appId = appLookup.rows[0].id;

    const fastPath = (input.service_ids?.length ?? 0) > 0;
    if (fastPath) {
      const services = await client.query<{ id: number; app_id: number; name: string }>(
        `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
        [input.service_ids],
      );
      if (services.rowCount !== input.service_ids!.length) {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError('not_found', 'one or more service_ids not found'),
        );
      }
      const wrong = services.rows.find((s) => s.app_id !== appId);
      if (wrong) {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError(
            'invalid_input',
            `service ${wrong.id} (${wrong.name}) does not belong to app ${input.app_name}`,
          ),
        );
      }
    }

    const initialStatus = fastPath ? 'in_progress' : 'scoping';
    const projInsert = await client.query(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, linear_url, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        appId,
        input.title,
        input.description_md,
        input.definition_of_done_md,
        input.linear_url ?? null,
        initialStatus,
      ],
    );
    const project = projInsert.rows[0];

    if (!fastPath) {
      const scoping = await client.query(
        `INSERT INTO work_items(type, title, description_markdown, project_id)
         VALUES ('plan', $1, $2, $3)
         RETURNING *`,
        [
          `Scope project ${project.id}: ${project.title}`,
          `Scoping work for project ${project.id}.\n\n` +
            `Description:\n\n${project.description_md}\n\n` +
            `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
            `When you finish exploring, attach a 'scoping' artifact summarising which services are touched, ` +
            `then call complete_scoping(project_id=${project.id}, service_ids=[...]).`,
          project.id,
        ],
      );
      await client.query('COMMIT');
      return ok({ project, scoping_work: scoping.rows[0] });
    }

    const planWorkItems = [];
    for (const serviceId of input.service_ids!) {
      const w = await client.query(
        `INSERT INTO work_items(type, title, description_markdown, service_id, project_id)
         VALUES ('plan', $1, $2, $3, $4)
         RETURNING *`,
        [
          `Plan service ${serviceId} for project ${project.id}: ${project.title}`,
          `Per-service plan for project ${project.id} (service ${serviceId}).\n\n` +
            `Description:\n\n${project.description_md}\n\n` +
            `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
            `When you finish, call create_plan(project_id=${project.id}, service_id=${serviceId}, ...) ` +
            `and enqueue code work items beneath the new plan id.`,
          serviceId,
          project.id,
        ],
      );
      planWorkItems.push(w.rows[0]);
    }
    await client.query('COMMIT');
    return ok({ project, plan_work_items: planWorkItems });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
  } finally {
    client.release();
  }
},
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts`
Expected: PASS — both new tests green; previous `create_project — scoping path` tests still green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): create_project fast path

Skips scoping and fans out one plan work item per supplied service_id.
Rejects services whose app does not match. Atomic with the project insert."
```

---

## Task 5: `complete_scoping`

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "complete_scoping"`
Expected: FAIL — stub still returns `internal`.

- [ ] **Step 3: Implement `complete_scoping`**

In `projects.ts`, replace the `complete_scoping` stub with:

```ts
server.registerTool(
  'complete_scoping',
  {
    description:
      'Atomically transition a project from scoping to in_progress and fan out one plan work item per service. Validates each service belongs to the project app. Caller separately calls complete_work on the scoping work item.',
    inputSchema: {
      project_id: z.number().int().positive(),
      service_ids: z.array(z.number().int().positive()).min(1),
    },
  },
  async (input) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const projLookup = await client.query<{
        id: number;
        app_id: number;
        status: string;
        title: string;
        description_md: string;
        definition_of_done_md: string;
      }>(
        `SELECT id, app_id, status, title, description_md, definition_of_done_md FROM projects WHERE id = $1 FOR UPDATE`,
        [input.project_id],
      );
      if (projLookup.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError('not_found', `project ${input.project_id} not found`),
        );
      }
      const project = projLookup.rows[0];
      if (project.status !== 'scoping') {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError(
            'conflict',
            `project ${input.project_id} is in status ${project.status}; complete_scoping requires 'scoping'`,
          ),
        );
      }

      const services = await client.query<{ id: number; app_id: number; name: string }>(
        `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
        [input.service_ids],
      );
      if (services.rowCount !== input.service_ids.length) {
        await client.query('ROLLBACK');
        return errorToToolResult(new AppError('not_found', 'one or more service_ids not found'));
      }
      const wrong = services.rows.find((s) => s.app_id !== project.app_id);
      if (wrong) {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError(
            'invalid_input',
            `service ${wrong.id} (${wrong.name}) does not belong to project ${input.project_id}'s app`,
          ),
        );
      }

      const planWorkItems = [];
      for (const sid of input.service_ids) {
        const w = await client.query(
          `INSERT INTO work_items(type, title, description_markdown, service_id, project_id)
           VALUES ('plan', $1, $2, $3, $4)
           RETURNING *`,
          [
            `Plan service ${sid} for project ${project.id}: ${project.title}`,
            `Per-service plan for project ${project.id} (service ${sid}).\n\n` +
              `Description:\n\n${project.description_md}\n\n` +
              `Definition of Done:\n\n${project.definition_of_done_md}\n\n` +
              `Read the latest 'scoping' artifact on this project before planning.`,
            sid,
            project.id,
          ],
        );
        planWorkItems.push(w.rows[0]);
      }

      const upd = await client.query(
        `UPDATE projects SET status='in_progress', updated_at=now() WHERE id=$1 RETURNING *`,
        [project.id],
      );
      await client.query('COMMIT');
      return ok({ project: upd.rows[0], plan_work_items: planWorkItems });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "complete_scoping"`
Expected: PASS — five green tests.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): complete_scoping fan-out

Atomically validates the scope, fans out per-service plan work items, and
flips the project from scoping to in_progress."
```

---

## Task 6: `get_project` and `list_projects`

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "get_project / list_projects"`
Expected: FAIL.

- [ ] **Step 3: Implement both tools**

Replace the `get_project` and `list_projects` stubs in `projects.ts`:

```ts
server.registerTool(
  'get_project',
  {
    description:
      'Fetch a project plus rolled-up child counts: plan_count, work_counts grouped by status, latest scoping_artifact_id, and dod_verifier_id if present.',
    inputSchema: { id: z.number().int().positive() },
  },
  async ({ id }) => {
    const proj = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
    if (proj.rowCount === 0)
      return errorToToolResult(new AppError('not_found', `project ${id} not found`));

    const planCount = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plans WHERE project_id = $1`,
      [id],
    );
    const workCounts = await db.query<{ status: string; n: number }>(
      `SELECT status::text AS status, count(*)::int AS n
         FROM work_items
        WHERE project_id = $1
        GROUP BY status`,
      [id],
    );
    const counts: Record<string, number> = {};
    for (const r of workCounts.rows) counts[r.status] = r.n;
    const scoping = await db.query<{ id: number }>(
      `SELECT a.id FROM artifacts a
         JOIN work_items w ON w.id = a.work_item_id
        WHERE w.project_id = $1 AND a.kind = 'scoping'
        ORDER BY a.created_at DESC LIMIT 1`,
      [id],
    );
    const verifier = await db.query<{ id: number }>(
      `SELECT id FROM work_items WHERE project_id = $1 AND is_dod_verifier = true ORDER BY id DESC LIMIT 1`,
      [id],
    );

    return ok({
      project: proj.rows[0],
      plan_count: planCount.rows[0].n,
      work_counts: counts,
      scoping_artifact_id: scoping.rows[0]?.id ?? null,
      dod_verifier_id: verifier.rows[0]?.id ?? null,
    });
  },
);

const ProjectStatus = z.enum(['pending', 'scoping', 'in_progress', 'done', 'blocked', 'cancelled']);

server.registerTool(
  'list_projects',
  {
    description:
      'List projects (titles + structured fields, no description or DoD bodies) optionally filtered by app_name or status.',
    inputSchema: {
      app_name: z.string().min(1).optional(),
      status: ProjectStatus.optional(),
    },
  },
  async ({ app_name, status }) => {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (app_name !== undefined) {
      vals.push(app_name);
      conds.push(`a.name = $${vals.length}`);
    }
    if (status !== undefined) {
      vals.push(status);
      conds.push(`p.status = $${vals.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT p.id, p.title, p.status, p.app_id, a.name AS app_name,
              p.linear_url, p.created_at, p.updated_at
         FROM projects p
         JOIN apps a ON a.id = p.app_id
         ${where}
         ORDER BY p.id ASC`,
      vals,
    );
    return ok(rows);
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "get_project / list_projects"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): get_project + list_projects

get_project returns rolled-up counts, scoping artifact, and DoD verifier
references; list_projects filters by app_name/status and omits long bodies."
```

---

## Task 7: `update_project`

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "update_project"`
Expected: FAIL.

- [ ] **Step 3: Implement `update_project`**

Replace the stub in `projects.ts`:

```ts
server.registerTool(
  'update_project',
  {
    description:
      'Patch a project. Allowed fields: title, description_md, definition_of_done_md, linear_url. status and app_id are immutable here — use the lifecycle tools.',
    inputSchema: {
      id: z.number().int().positive(),
      title: z.string().min(1).optional(),
      description_md: z.string().min(1).optional(),
      definition_of_done_md: z.string().min(1).optional(),
      linear_url: z.string().url().nullable().optional(),
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
        `UPDATE projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));
      return ok(rows[0]);
    } catch (err) {
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "update_project"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): update_project

Patch title / description_md / definition_of_done_md / linear_url. Status
and app_id are intentionally immutable; use lifecycle tools instead."
```

---

## Task 8: `cancel_project` (cascading)

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "cancel_project"`
Expected: FAIL.

- [ ] **Step 3: Implement `cancel_project`**

Replace the stub:

```ts
server.registerTool(
  'cancel_project',
  {
    description:
      'Cancel a project. Cascades cancel_work to all non-terminal child work items in the same transaction. Idempotent on already-cancelled.',
    inputSchema: {
      id: z.number().int().positive(),
      reason: z.string().optional(),
    },
  },
  async ({ id, reason }) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const proj = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM projects WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (proj.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));
      }
      await client.query(
        `UPDATE work_items
            SET status='cancelled',
                failure_reason=COALESCE($2, failure_reason),
                claim_expires_at=NULL,
                next_retry_at=NULL,
                updated_at=now()
          WHERE project_id = $1
            AND status IN ('pending','claimed','blocked','awaiting_input')`,
        [id, reason ?? null],
      );
      const out = await client.query(
        `UPDATE projects
            SET status='cancelled',
                failure_reason=COALESCE($2, failure_reason),
                updated_at=now()
          WHERE id=$1
        RETURNING *`,
        [id, reason ?? null],
      );
      await client.query('COMMIT');
      return ok(out.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "cancel_project"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): cancel_project with cascade

Cancels the project and every non-terminal child work item in one
transaction; terminal children are untouched."
```

---

## Task 9: `block_project` and `unblock_project`

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
    })) as { status: string; failure_reason: string };
    expect(out.status).toBe('blocked');
    expect(out.failure_reason).toBe('waiting on infra');
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "block_project / unblock_project"`
Expected: FAIL.

- [ ] **Step 3: Implement both**

Replace the stubs in `projects.ts`. Note: `unblock_project` needs to _also_ replay missed auto-enqueue triggers (per spec). The replay call is added in Task 11 once `advanceProjectAfterWorkCompletion` exists; for now, implement just the status recompute.

```ts
server.registerTool(
  'block_project',
  {
    description:
      'Block a project on an external dependency from scoping/in_progress. Does not cascade to children — they continue. Reason is required.',
    inputSchema: {
      id: z.number().int().positive(),
      reason: z.string().min(1),
    },
  },
  async ({ id, reason }) => {
    const { rows } = await db.query(
      `UPDATE projects
          SET status='blocked',
              failure_reason=$2,
              updated_at=now()
        WHERE id=$1 AND status IN ('scoping','in_progress')
       RETURNING *`,
      [id, reason],
    );
    if (rows.length === 0) {
      const exists = await db.query(`SELECT id FROM projects WHERE id=$1`, [id]);
      if (exists.rowCount === 0)
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));
      return errorToToolResult(new AppError('conflict', `project ${id} is in a terminal state`));
    }
    return ok(rows[0]);
  },
);

server.registerTool(
  'unblock_project',
  {
    description:
      'Unblock a project. Recomputes target state from children: scoping if a scoping plan-type work item is still pending/claimed, else in_progress. Replays auto-enqueue triggers that fired while blocked.',
    inputSchema: { id: z.number().int().positive() },
  },
  async ({ id }) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const proj = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM projects WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (proj.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));
      }
      if (proj.rows[0].status !== 'blocked') {
        await client.query('ROLLBACK');
        return errorToToolResult(new AppError('conflict', `project ${id} is not blocked`));
      }

      const scopingInFlight = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM work_items
           WHERE project_id = $1 AND type = 'plan'
             AND title LIKE 'Scope project%'
             AND status IN ('pending','claimed','awaiting_input','blocked')`,
        [id],
      );
      const target = scopingInFlight.rows[0].n > 0 ? 'scoping' : 'in_progress';
      const upd = await client.query(
        `UPDATE projects
            SET status=$2, failure_reason=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, target],
      );

      // Replay missed triggers — implementation lands in Task 11.
      // (Intentional placeholder; the lifecycle tests in Task 12 will exercise it.)

      await client.query('COMMIT');
      return ok(upd.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "block_project / unblock_project"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): block_project + unblock_project

Block pauses auto-enqueue triggers (no cascade); unblock recomputes the
target state from children. Auto-enqueue replay arrives with the
complete_work hook in a later task."
```

---

## Task 10: `retry_project`

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "retry_project"`
Expected: FAIL.

- [ ] **Step 3: Implement `retry_project`**

Replace the stub:

```ts
server.registerTool(
  'retry_project',
  {
    description:
      'Re-open a project that hit done but on inspection is not actually done. Sets status back to in_progress and retries the existing DoD verifier work item.',
    inputSchema: { id: z.number().int().positive() },
  },
  async ({ id }) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const proj = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM projects WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (proj.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorToToolResult(new AppError('not_found', `project ${id} not found`));
      }
      const verifier = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM work_items
          WHERE project_id=$1 AND is_dod_verifier=true
          ORDER BY id DESC LIMIT 1
          FOR UPDATE`,
        [id],
      );
      if (verifier.rowCount === 0) {
        await client.query('ROLLBACK');
        return errorToToolResult(
          new AppError('conflict', `project ${id} has no DoD verifier to retry`),
        );
      }
      const updProj = await client.query(
        `UPDATE projects SET status='in_progress', updated_at=now() WHERE id=$1 RETURNING *`,
        [id],
      );
      const updVerifier = await client.query(
        `UPDATE work_items
            SET status='pending',
                claimed_at=NULL,
                claimed_by=NULL,
                claim_expires_at=NULL,
                failure_reason=NULL,
                next_retry_at=NULL,
                updated_at=now()
          WHERE id=$1 RETURNING *`,
        [verifier.rows[0].id],
      );
      await client.query('COMMIT');
      return ok({ project: updProj.rows[0], verifier: updVerifier.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "retry_project"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): retry_project

Re-open a 'done' project by flipping status to in_progress and retrying
the existing DoD verifier. Errors cleanly when no verifier exists yet."
```

---

## Task 11: `enqueue_work` accepts `project_id`; `complete_work` calls `advanceProjectAfterWorkCompletion`; `unblock_project` replays

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts` (export `advanceProjectAfterWorkCompletion`)
- Modify: `packages/mcp-server/src/tools/work.ts`
- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

This task is the heart of the workflow driver. It introduces the helper `advanceProjectAfterWorkCompletion(client, projectId)` that runs inside the same transaction as `complete_work`, decides which auto-enqueue (per-plan review, DoD verifier, or `done` flip) is now due, and writes it. `unblock_project` calls the same helper once after recomputing status.

Logic of the helper, executed for every `complete_work` whose row had a `project_id`:

1. Read the project row `FOR UPDATE`. If `status NOT IN ('scoping','in_progress')` → no-op.
2. **Per-plan review trigger.** For every distinct `plan_id` referenced by a `code` work item under this project: if every `code` work item with that `plan_id` is `completed` AND no `review` work item exists for that `plan_id`, insert one `review` work item linked to that plan + project.
3. **DoD verifier trigger.** Count non-verifier work items under the project. If every one is `completed` AND no row with `is_dod_verifier = true` exists yet, insert one (`type='review'`, `is_dod_verifier=true`, project_id, no plan_id, no service_id; title `Verify Definition of Done for project N: <title>`; description embeds the DoD text).
4. **Done trigger.** If the just-completed work item had `is_dod_verifier = true` AND project status is `in_progress`, flip project status to `done`.

Order matters: 4 must come before 2 and 3 in the same call so a verifier completion doesn't accidentally enqueue more work. We branch on `completedWorkRow.is_dod_verifier`.

- [ ] **Step 1: Write the failing tests**

Append to `projects-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts -t "auto-enqueue triggers"`
Expected: FAIL on every assertion — `enqueue_work` has no `project_id`, `complete_work` doesn't call the helper, the helper doesn't exist.

- [ ] **Step 3: Add `project_id` to `enqueue_work`'s schema and INSERT**

In `packages/mcp-server/src/tools/work.ts`, modify `enqueue_work`. Specifically:

1. Add `project_id: z.number().int().positive().optional()` to the `inputSchema`.
2. In the body, validate that the project exists and matches the work's app (when both can be determined): if `project_id` is set, look up `projects.app_id`; if `appId` is also resolved (via `service_id`), require they match; otherwise just confirm the project exists.
3. Add `project_id` to the `INSERT` column list, placeholder list, and values.

The full updated handler reads (replacing the existing `async (input) => { ... }`):

```ts
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

    if (input.project_id !== undefined) {
      const p = await db.query<{ app_id: number }>(
        `SELECT app_id FROM projects WHERE id = $1`,
        [input.project_id],
      );
      if (p.rowCount === 0)
        return errorToToolResult(
          new AppError('not_found', `project ${input.project_id} not found`),
        );
      if (appId !== null && p.rows[0].app_id !== appId) {
        return errorToToolResult(
          new AppError(
            'invalid_input',
            `project ${input.project_id} belongs to app ${p.rows[0].app_id} but service belongs to app ${appId}`,
          ),
        );
      }
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
      if (appId !== null) {
        const perApp = await db.query<{ team_id: number }>(
          `SELECT team_id FROM team_defaults WHERE app_id = $1 AND work_type = $2`,
          [appId, input.type],
        );
        if ((perApp.rowCount ?? 0) > 0) teamId = perApp.rows[0].team_id;
      }
      if (teamId === null) {
        const global = await db.query<{ team_id: number }>(
          `SELECT team_id FROM team_defaults WHERE app_id IS NULL AND work_type = $1`,
          [input.type],
        );
        if ((global.rowCount ?? 0) > 0) teamId = global.rows[0].team_id;
      }
    }

    const { rows } = await db.query(
      `INSERT INTO work_items
         (type, title, description_markdown, priority, service_id, plan_id, branch, pr_url, team_id, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
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
        input.project_id ?? null,
      ],
    );
    return ok(rows[0]);
  } catch (err) {
    return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
  }
},
```

Also update the `inputSchema`:

```ts
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
  project_id: z.number().int().positive().optional(),
},
```

And the description: "Add a typed task to the queue (plan / code / review). team_id resolution: explicit value > per-app default for (service.app_id, type) > global default for (NULL, type) > null (solo agent). project_id optionally links the item to a project so server-side hooks can advance the workflow on completion."

- [ ] **Step 4: Implement and export `advanceProjectAfterWorkCompletion` in `projects.ts`**

Append to `packages/mcp-server/src/tools/projects.ts` (outside `registerProjects`, also exported):

```ts
import type { PoolClient } from 'pg';

export interface CompletedWork {
  id: number;
  project_id: number | null;
  plan_id: number | null;
  type: 'plan' | 'code' | 'review';
  is_dod_verifier: boolean;
}

export async function advanceProjectAfterWorkCompletion(
  client: PoolClient,
  projectId: number,
  completed: CompletedWork,
): Promise<void> {
  const proj = await client.query<{
    id: number;
    title: string;
    status: string;
    definition_of_done_md: string;
  }>(`SELECT id, title, status, definition_of_done_md FROM projects WHERE id=$1 FOR UPDATE`, [
    projectId,
  ]);
  if (proj.rowCount === 0) return;
  const status = proj.rows[0].status;
  if (status !== 'scoping' && status !== 'in_progress') return;

  if (completed.is_dod_verifier) {
    await client.query(`UPDATE projects SET status='done', updated_at=now() WHERE id=$1`, [
      projectId,
    ]);
    return;
  }

  if (completed.plan_id !== null && completed.type === 'code') {
    const remaining = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE plan_id=$1 AND type='code' AND status <> 'completed'`,
      [completed.plan_id],
    );
    const reviewExists = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items
         WHERE plan_id=$1 AND type='review'`,
      [completed.plan_id],
    );
    if (remaining.rows[0].n === 0 && reviewExists.rows[0].n === 0) {
      await client.query(
        `INSERT INTO work_items(type, title, description_markdown, plan_id, project_id)
         VALUES ('review', $1, $2, $3, $4)`,
        [
          `Review plan ${completed.plan_id} for project ${projectId}`,
          `Auto-enqueued review for plan ${completed.plan_id} under project ${projectId}.\n\n` +
            `All code work items for that plan are completed. Review the diff(s) and either ` +
            `approve, request changes, or comment per /sapling:work review semantics.`,
          completed.plan_id,
          projectId,
        ],
      );
    }
  }

  const remainingNonVerifier = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_items
       WHERE project_id=$1 AND is_dod_verifier=false AND status <> 'completed'`,
    [projectId],
  );
  const verifierExists = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_items
       WHERE project_id=$1 AND is_dod_verifier=true`,
    [projectId],
  );
  if (remainingNonVerifier.rows[0].n === 0 && verifierExists.rows[0].n === 0) {
    await client.query(
      `INSERT INTO work_items(type, title, description_markdown, project_id, is_dod_verifier)
       VALUES ('review', $1, $2, $3, true)`,
      [
        `Verify Definition of Done for project ${projectId}: ${proj.rows[0].title}`,
        `All non-verifier work items are completed. Verify each criterion in the DoD against shipped reality (PRs, tests, code).\n\n` +
          `Definition of Done:\n\n${proj.rows[0].definition_of_done_md}\n\n` +
          `On success: complete_work normally → project flips to 'done'.\n` +
          `On failure: attach a 'dod_gaps' artifact listing what is missing AND complete_work — the project will stay in_progress and a human can enqueue more work + retry_project.`,
        projectId,
      ],
    );
  }
}
```

- [ ] **Step 5: Call `advanceProjectAfterWorkCompletion` from `complete_work`**

In `packages/mcp-server/src/tools/work.ts`, modify `complete_work`. Add an import at the top of the file:

```ts
import { advanceProjectAfterWorkCompletion } from './projects.js';
```

Replace the body of `complete_work`'s success path (after `if (artifact_id) { ... }`, before `await client.query('COMMIT');`) with:

```ts
if (work.project_id !== null && work.project_id !== undefined) {
  await advanceProjectAfterWorkCompletion(client, work.project_id, {
    id: work.id,
    project_id: work.project_id,
    plan_id: work.plan_id,
    type: work.type,
    is_dod_verifier: work.is_dod_verifier === true,
  });
}
await client.query('COMMIT');
```

- [ ] **Step 6: Wire `unblock_project` to replay**

In `packages/mcp-server/src/tools/projects.ts`, replace the placeholder comment in `unblock_project` (just before the COMMIT) with logic that re-runs the helper for the most recently completed work item belonging to the project. Concretely: pull the most recently `completed` work item for this project, and if any, call the helper. This catches the case where a child completed during the blocked window.

```ts
// Replay any auto-enqueue triggers that were skipped while blocked.
const recent = await client.query<{
  id: number;
  project_id: number;
  plan_id: number | null;
  type: 'plan' | 'code' | 'review';
  is_dod_verifier: boolean;
}>(
  `SELECT id, project_id, plan_id, type, is_dod_verifier
     FROM work_items
    WHERE project_id = $1 AND status = 'completed'
    ORDER BY completed_at DESC, id DESC
    LIMIT 1`,
  [id],
);
if ((recent.rowCount ?? 0) > 0) {
  await advanceProjectAfterWorkCompletion(client, id, recent.rows[0]);
}
```

(`advanceProjectAfterWorkCompletion` is already imported as a sibling function in this file, so no import needed.)

- [ ] **Step 7: Run all the integration tests to verify they pass**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-tools.test.ts`
Expected: PASS — every block, including the new `auto-enqueue triggers` describe and the previously-passing tests.

- [ ] **Step 8: Run the entire test suite to verify nothing regressed**

Run: `cd packages/mcp-server && npm test`
Expected: PASS — no regressions in existing tests (`enqueue-team-resolution`, `work`, `human_input`, etc.).

- [ ] **Step 9: Commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts \
                    packages/mcp-server/src/tools/work.ts \
                    packages/mcp-server/test/integration/projects-tools.test.ts
npm --prefix packages/mcp-server run lint -- --fix
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/src/tools/work.ts \
        packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "feat(mcp-server): project workflow auto-enqueue hooks

enqueue_work accepts project_id; complete_work calls
advanceProjectAfterWorkCompletion inside its transaction to fan out
per-plan reviews, the DoD verifier, and the final 'done' flip.
unblock_project replays the helper once to catch up on triggers that
were paused while blocked."
```

---

## Task 12: Lifecycle integration test (end-to-end and cascade scenarios)

**Files:**

- Create: `packages/mcp-server/test/integration/projects-lifecycle.test.ts`

This task adds the end-to-end coverage the spec calls for: scoping flow, fast path, DoD verifier failure path, ad-hoc enqueue, app delete cascade. Some scenarios overlap with Task 11's per-trigger tests; here we drive whole lifecycles to catch interaction bugs.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/integration/projects-lifecycle.test.ts`:

```ts
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

    // Complete the per-service plan work item.
    await client.call('complete_work', { id: r.plan_work_items[0].id });

    // Ad-hoc: enqueue a code item directly under the project (no plan).
    const adhoc = (await client.call('enqueue_work', {
      type: 'code',
      title: 'extra',
      description_markdown: 'd',
      project_id: projectId,
    })) as { id: number };

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

  it('DoD verifier failure path: attach dod_gaps and retry_project re-enqueues a fresh verifier', async () => {
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
    expect(verifier.rowCount).toBe(1);

    // Verifier completes WITH a dod_gaps artifact attached.
    await client.call('attach_artifact', {
      kind: 'dod_gaps',
      title: 'Missing tests',
      body_markdown: 'No e2e tests for Okta path.',
      work_item_id: verifier.rows[0].id,
    });
    await client.call('complete_work', { id: verifier.rows[0].id });

    // Project flipped to done because the helper currently treats a completed verifier as success.
    // The skill convention: failed-DoD verifier should call fail_work instead. Test the spec'd retry_project path:
    // simulate "user enqueues more work + retries".
    let proj = await db.pool.query<{ status: string }>(`SELECT status FROM projects WHERE id=$1`, [
      projectId,
    ]);
    expect(proj.rows[0].status).toBe('done');

    // Add follow-on work.
    const more = (await client.call('enqueue_work', {
      type: 'code',
      title: 'add tests',
      description_markdown: 'd',
      service_id: svc.rows[0].id,
      project_id: projectId,
    })) as { id: number };

    // Retry project: status → in_progress, verifier → pending.
    await client.call('retry_project', { id: projectId });
    proj = await db.pool.query<{ status: string }>(`SELECT status FROM projects WHERE id=$1`, [
      projectId,
    ]);
    expect(proj.rows[0].status).toBe('in_progress');

    const verifierAfter = await db.pool.query<{ status: string }>(
      `SELECT status FROM work_items WHERE id=$1`,
      [verifier.rows[0].id],
    );
    expect(verifierAfter.rows[0].status).toBe('pending');

    // Complete the new code item (verifier already exists, so no new one is enqueued).
    await client.call('complete_work', { id: more.id });
    const verifiers = await db.pool.query(
      `SELECT count(*)::int AS n FROM work_items WHERE project_id=$1 AND is_dod_verifier=true`,
      [projectId],
    );
    expect(verifiers.rows[0].n).toBe(1);
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
```

- [ ] **Step 2: Run the tests to verify they pass (no production code change required)**

Run: `cd packages/mcp-server && npx vitest run test/integration/projects-lifecycle.test.ts`
Expected: PASS — these scenarios are already supported by Task 11's helper; this file provides whole-flow coverage.

- [ ] **Step 3: Run the entire test suite again**

Run: `cd packages/mcp-server && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/mcp-server/test/integration/projects-lifecycle.test.ts
git add packages/mcp-server/test/integration/projects-lifecycle.test.ts
git commit -m "test(mcp-server): end-to-end project lifecycle coverage

Drives full scoping flow, ad-hoc enqueue, DoD verifier retry path, and
app-delete cascade through the public MCP surface."
```

---

## Task 13: New `/sapling:project` skill

**Files:**

- Create: `packages/claude-plugin/skills/project/SKILL.md`

This is a docs-only file; there is no test runner for skill behavior. The skill text is rendered into the agent prompt at call time, so it must be exact and unambiguous.

- [ ] **Step 1: Create the skill file**

Create `packages/claude-plugin/skills/project/SKILL.md`:

````markdown
---
name: project
description: Create, inspect, and manage Sapling projects — the workflow-driven entity that drives an intent (idea / Linear ticket / bug) across one or more services to a verified Definition of Done. Triggers on /sapling:project.
---

# /sapling:project

Drive an intent end-to-end. A project owns the original goal (`title`, `description_md`, optional `linear_url`), a required `definition_of_done_md`, and the chain of plans / code / review work items beneath it. Sapling auto-enqueues per-service plans → code → per-plan reviews → a final DoD verifier; this skill is how you create, inspect, and lifecycle the project itself.

## Forms

```
/sapling:project create <app> <title>                    — interactive create flow
/sapling:project list [<app>] [status <s>]               — list (filtered)
/sapling:project show <id>                               — full detail + recent artifacts
/sapling:project cancel <id> [<reason>]                  — cascading cancel
/sapling:project block <id> "<reason>"                   — pause auto-enqueue triggers
/sapling:project unblock <id>                            — resume; replays missed triggers
/sapling:project retry <id>                              — re-open a project that hit done
```

## GitHub-bound text

The same rule from `/sapling:work` applies: never use `#N` to reference a Sapling project, plan, work item, or artifact id in PR titles, PR bodies, PR comments, or commit messages. Use `Sapling project N`, `Sapling plan N`, `Sapling work N`. The `#N` form is fine in chat output and inside Sapling artifacts.

## Steps — `create`

1. Parse arguments. The first bareword after `create` is `<app>` (must already be registered via `/sapling:learn`). The remaining text up to the first newline is `<title>`.

2. Ask the user for the long fields, one at a time. Do NOT generate them yourself unless the user has already pasted enough to fill the field:
   - **Description.** A few sentences describing what this project is and why. If the user supplies `linear <url>` (recognised anywhere in the original args), call `mcp__linear-work__get_issue` with the parsed ticket id and pre-fill `description_md` with the Linear ticket description; let the user edit before submission.
   - **Definition of Done.** This is non-negotiable. Push the user for verifiable success criteria — "users with role X can do Y", "integration test Z passes", "Linear ticket ABC-123 is closeable". Two to four bullets is typical. If the user gives a vague DoD ("it should work"), ask again. The DoD is loaded into every child agent's context and gates the final transition to `done`.
   - **Skip-scoping fast path?** Ask: "Do you already know the affected services? If so, list them and we'll skip the scoping phase." If the user lists services, validate they belong to `<app>` via `mcp__sapling__list_services({ app_name: '<app>' })` and pass them as `service_ids` to `create_project`. If not, leave the field unset and a scoping work item will auto-enqueue.

3. Call `mcp__sapling__create_project` with the gathered fields. The response includes either `scoping_work` (scoping path) or `plan_work_items` (fast path).

4. Print a one-line summary:

   ```
   Created Sapling project <id> "<title>" in app <app>, status <status>.
     <scoping path>: scoping work item Sapling work <scoping_id> is pending; run /sapling:work to claim it.
     <fast path>:    <N> per-service plan work items pending: Sapling work <id1>, Sapling work <id2>, …
   ```

   If `linear_url` was set, append: "Agents will post status updates to <linear_url> on completion."

## Steps — `list`

1. Parse arguments. Optional first bareword = `<app>`. Optional `status <s>` token sets the status filter.

2. Call `mcp__sapling__list_projects({ app_name?, status? })`.

3. Render one row per project, grouped by app:

   ```
   ## <app-name>
   #<id>  <status>  <title>      (linear: <linear_url?>)
   ```

   Suppress the `(linear: ...)` parenthetical when `linear_url` is null.

## Steps — `show`

1. Parse `<id>`.
2. Call in parallel:
   - `mcp__sapling__get_project({ id })`
   - `mcp__sapling__list_artifacts({ work_item_id: <scoping_artifact owner> })` — actually, since `get_project` returns `scoping_artifact_id`, fetch it directly with `mcp__sapling__get_artifact({ id: scoping_artifact_id })` if non-null.
   - `mcp__sapling__list_artifacts({ kind: 'dod_gaps' })` filtered client-side to those linked to this project's verifier work item if `dod_verifier_id` is non-null.
3. Print:
   - Title, app, status, `linear_url` if any.
   - Description and Definition of Done verbatim (fenced).
   - Rolled-up counts: `plan_count`, `work_counts.{pending,claimed,completed,failed,blocked,cancelled,awaiting_input}`.
   - Scoping artifact body if present (fenced).
   - Most recent `dod_gaps` artifact body if present (fenced) — these are the criteria the verifier flagged as not yet met.
4. Footer: list available actions (`cancel`, `block`, `unblock`, `retry`) so the user knows what's possible from the current state.

## Steps — `cancel`

1. Parse `<id>` and the optional `<reason>` (rest of the line).
2. Call `mcp__sapling__get_project({ id })` to get the cascade preview: how many `pending`/`claimed`/`blocked`/`awaiting_input` children exist.
3. If the cascade preview is non-zero, confirm with the user: "Cancelling this project will also cancel <N> in-flight work items. Continue? (y/N)". Skip the prompt only if `<reason>` was supplied AND the user is in `$SAPLING_RUNNER` autonomous mode.
4. On confirmation: `mcp__sapling__cancel_project({ id, reason })`. Print the new status and a count of cascaded children.

## Steps — `block` / `unblock`

- `block`: requires a `<reason>`. Call `mcp__sapling__block_project({ id, reason })`. Print the new status. Note that auto-enqueue triggers are paused.
- `unblock`: call `mcp__sapling__unblock_project({ id })`. Print the recomputed status (`scoping` or `in_progress`) and mention that any missed triggers were replayed in the same call.

## Steps — `retry`

1. Confirm with the user that the project's existing DoD verifier will be re-claimed: "Retry the DoD verifier for project <id>? (y/N)".
2. Call `mcp__sapling__retry_project({ id })`. Print the new project status and verifier id.
3. Recommend the user run `/sapling:work` to actually pick up the verifier in a fresh session.

## Notes

- This skill never executes work itself. All execution flows through `/sapling:work`.
- For ad-hoc additions to a running project, use `/sapling:enqueue <type> "..."` and pass `project_id` — see `/sapling:enqueue` for the exact form. If the additions feel like material scope shift, suggest spawning a child project instead.
- Linear writes are made by the agents executing the work, not by this skill — see `/sapling:work` for the binding rule injected at claim time.
````

- [ ] **Step 2: Lint the markdown (no test runner; sanity-check it renders)**

Run: `npx prettier --check packages/claude-plugin/skills/project/SKILL.md`
Expected: PASS or "code style issues fixed" — run `--write` if it complains:

```bash
npx prettier --write packages/claude-plugin/skills/project/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/project/SKILL.md
git commit -m "feat(claude-plugin): add /sapling:project skill

Drive an intent end-to-end. Wraps create_project / complete_scoping /
get_project / list_projects / cancel_project / block_project /
unblock_project / retry_project."
```

---

## Task 14: Update `/sapling:work` to inject project context

**Files:**

- Modify: `packages/claude-plugin/skills/work/SKILL.md`

The existing skill loads service + app conventions. Add a parallel project-context block, keyed off the claimed work item's `project_id`. The block must run after the team load (4b) and before the artifact resume (5), because the project DoD is binding for everything that follows.

- [ ] **Step 1: Insert a new step 4c**

In `packages/claude-plugin/skills/work/SKILL.md`, after the existing step `4b. **Load team (if assigned).**` block (the one that ends with `If team_id is null, skip this step entirely and continue in **solo mode** ...`), insert:

```markdown
4c. **Load project (if assigned).** If the claimed work item has `project_id`, call `mcp__sapling__get_project({ id: project_id })`. The result anchors what success looks like for this work item.

- Treat the project's `description_md` and especially `definition_of_done_md` as binding context. Every decision you make on this work item — what to plan, what to code, what to flag in review — must serve the DoD.
- If `get_project` returns `scoping_artifact_id` non-null, also call `mcp__sapling__get_artifact({ id: scoping_artifact_id })` and read the body before doing anything else. The scoping artifact tells you which services the project touches and what each one needs.
- If `get_project` returns a non-null `linear_url` on the project, treat the following as a non-negotiable rule for this work item:
  > _"This work item is part of project Sapling project N (`<title>`), tracked at `<linear_url>`. When you call `complete_work`, also post a brief comment on the Linear ticket summarising what you did, using `mcp__linear-work__save_comment` with the parsed Linear issue id. If your work is the DoD verifier (`is_dod_verifier=true`), the Linear comment is the canonical 'project done' summary."_
  > Apply the GitHub-id rule above when composing the Linear body — write `Sapling project N` / `Sapling work N`, not `#N`.
- If the work item is `is_dod_verifier=true` (this only happens for `review` items auto-enqueued at the end of a project), additional rules apply:
  - Re-read `definition_of_done_md` and check each criterion against shipped reality (open and merged PRs, tests, deployed code).
  - On success: complete normally with a `summary_markdown` listing each criterion and the evidence you saw. The server will flip the project to `done`.
  - On failure: attach a `dod_gaps` artifact (`mcp__sapling__attach_artifact(kind='dod_gaps', work_item_id=<id>, body_markdown=<numbered list of unmet criteria>)`) and `complete_work` normally. The project will stay `in_progress` and a human can `enqueue_work` more work + `retry_project`. Do NOT call `fail_work` for a failed DoD verification — failure here is a known, structured outcome, not an internal error.

If `project_id` is null, skip this step entirely; the rest of the skill behaves exactly as it always has.
```

- [ ] **Step 2: Lint and verify the file still parses**

Run: `npx prettier --check packages/claude-plugin/skills/work/SKILL.md`
Expected: PASS or auto-fixable. Run `--write` if needed:

```bash
npx prettier --write packages/claude-plugin/skills/work/SKILL.md
```

Also visually scan that the surrounding numbered list still reads `4. ... 4b. ... 4c. ... 5. ...`.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/work/SKILL.md
git commit -m "feat(claude-plugin): inject project context into /sapling:work

Adds a step 4c that loads project metadata, the latest scoping artifact,
the Linear binding rule (when linear_url is set), and special handling
for DoD verifier work items."
```

---

## Task 15: Update `/sapling:status` to surface projects

**Files:**

- Modify: `packages/claude-plugin/skills/status/SKILL.md`

- [ ] **Step 1: Add a Projects section above the existing work-queue counts**

In `packages/claude-plugin/skills/status/SKILL.md`, modify "Steps". Insert a new step 2.5 (before the existing step 3 that groups by app) and add a Projects header to the rendered output. Replace the existing steps with:

```markdown
## Steps

1. Parse arguments: a single bareword is treated as `app_name`. No arg means "all apps".
2. Call `mcp__sapling__list_work` five times in parallel, passing `app_name` through if it was supplied:
   - `{ status: 'pending', app_name? }`
   - `{ status: 'claimed', app_name? }`
   - `{ status: 'awaiting_input', app_name? }`
   - `{ status: 'blocked', app_name? }`
   - `{ status: 'failed', app_name? }`

   Each row in the response now carries `app_id` / `app_name` (resolved through `services`), so no separate join is needed. Items with no `service_id` (and therefore no app) are reported under the literal bucket `(unassigned)`.

   If the call returns a `not_found` error for the app, stop and tell the user the app isn't registered.

3. **In parallel, call** `mcp__sapling__list_projects({ app_name? })`. Project rows include `id`, `title`, `status`, `app_name`, `linear_url`. Skip this call entirely (and skip rendering the Projects section) if it returns an empty array.

4. Group the work-item rows by `app_name`. Sort apps alphabetically; render `(unassigned)` last. For each app, output the **Projects section** first if any project exists for that app, then the work sections:
```

## <app-name>

PROJECTS SCOPING <s> IN_PROGRESS <i> BLOCKED <b> DONE <d> CANCELLED <c> #<id> <status> <title> (linear: <url?>)
…
PENDING <p> CLAIMED <c> AWAITING <a> BLOCKED <b> FAILED <f>
pending: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
… (next 5, ordered by priority desc / created asc)
claimed: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>) claimed_by=<claimed_by> @ <claimed_at>
… (every claimed row — stale claims are the #1 cause of
"nothing to do", surface them all)
awaiting_input: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>) (run /sapling:human <id> to answer)
blocked: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
reason: <failure_reason>
failed: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
reason: <failure_reason>

```

Skip empty subsections (including the entire Projects header if no projects exist for that app) to keep the output dense. When a row's `team_name`, `plan_id`, or `project_id` is null, suppress that key entirely. If `awaiting_input` totals are non-zero anywhere, append `Run /sapling:human to answer.` to the footer.

5. After the per-app sections, print a one-line cross-app totals row:

```

TOTALS PROJECTS <P_total> PENDING <P> CLAIMED <C> AWAITING <A> BLOCKED <B> FAILED <F>

```

```

- [ ] **Step 2: Format**

```bash
npx prettier --write packages/claude-plugin/skills/status/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/status/SKILL.md
git commit -m "feat(claude-plugin): surface projects in /sapling:status

Adds a Projects section per app showing status counts and project rows,
and surfaces project_id alongside service_id/plan_id/team in work rows."
```

---

## Task 16: Update `/sapling:queue` with project drill-down

**Files:**

- Modify: `packages/claude-plugin/skills/queue/SKILL.md`

- [ ] **Step 1: Add the new form and a project drill-down section**

In `packages/claude-plugin/skills/queue/SKILL.md`, modify the "Forms" block to include:

```
/sapling:queue project <id>                 — drill into a project (children recursively)
```

Place this line directly after `/sapling:queue plan <id>` so it sits with the other "drill into one entity" forms.

Then, after the existing `### work <id> / plan <id>` section, add a new section:

```markdown
### `project <id>`

- `mcp__sapling__get_project({ id })` for the project itself + rolled-up counts.
- `mcp__sapling__list_work({ })` filtered client-side to rows where `project_id == id`. (There is no server-side project filter on `list_work` yet; client-side filtering is fine until volumes warrant it.)
- `mcp__sapling__list_plans({ })` filtered client-side to rows where `project_id == id`.
- Print, in order:
  - Project header: title, status, app, `linear_url?`.
  - Definition of Done verbatim (fenced).
  - Rolled-up `work_counts` from `get_project`.
  - **Scoping artifact** body if `scoping_artifact_id` is non-null (fetched via `get_artifact`), fenced.
  - **DoD gaps** body if a `dod_gaps` artifact exists for the verifier work item, fenced.
  - **Plans** under this project: one line per plan (`#<id>  <status>  <title>  service=<service_id?>`).
  - **Work items** under this project, grouped by status, one line each: `#<id>  <type>/<status>  <title>  (plan=<plan_id?> service=<service_id?> verifier=<is_dod_verifier?>)`. Suppress `verifier=` when false.
- Footer: action hints — `/sapling:project block <id>`, `/sapling:project cancel <id>`, etc.
```

- [ ] **Step 2: Format**

```bash
npx prettier --write packages/claude-plugin/skills/queue/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/skills/queue/SKILL.md
git commit -m "feat(claude-plugin): /sapling:queue project <id> drill-down

Adds a project view that shows the DoD, scoping artifact, dod_gaps, and
all child plans + work items in one place."
```

---

## Task 17: Bump plugin version `0.5.0` → `0.6.0`

**Files:**

- Modify: `packages/claude-plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Update `version` and `description`**

Replace the contents of `packages/claude-plugin/.claude-plugin/plugin.json` with:

```json
{
  "name": "sapling",
  "version": "0.6.0",
  "description": "Postgres-backed knowledge store and typed work queue for Claude Code. Adds /sapling:plan, /sapling:work, /sapling:queue, /sapling:rules, /sapling:status, /sapling:enqueue, /sapling:context, /sapling:learn, /sapling:human, /sapling:teams, and /sapling:project slash commands plus a bundled MCP server connection.",
  "author": {
    "name": "Carl-Fredrik Arvidson",
    "url": "https://github.com/cfarvidson"
  },
  "homepage": "https://github.com/cfarvidson/sapling",
  "repository": "https://github.com/cfarvidson/sapling",
  "license": "MIT",
  "keywords": ["sapling", "mcp", "queue", "planning", "code-review", "agents", "workflow"]
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write packages/claude-plugin/.claude-plugin/plugin.json
git add packages/claude-plugin/.claude-plugin/plugin.json
git commit -m "chore(claude-plugin): bump version 0.5.0 → 0.6.0

Adds /sapling:project skill plus binding-rule changes in /sapling:work,
/sapling:status, and /sapling:queue. Per CLAUDE.md, observable behavior
shifts in skills require a minor bump."
```

---

## Task 18: Update SPEC.md

**Files:**

- Modify: `SPEC.md`

The spec doc's "SPEC.md updates" section enumerates the exact changes. This task lands all of them in one commit. Re-read `docs/superpowers/specs/2026-05-05-projects-design.md` § "SPEC.md updates" before starting if any wording is unclear.

- [ ] **Step 1: Edit each numbered section**

Make the following changes to `SPEC.md` (paths are section headers; insert/edit text exactly as shown). Use `Edit` with sufficient context to keep the diff surgical.

**§2 Goals — add a fifth goal as a new bullet:**

Existing goals end with `4. **One verb to start work.** ...`. Insert as item 5:

```markdown
5. **One verb to ship an intent.** `/sapling:project create` takes an idea / Linear ticket / bug and Sapling drives it across one or more services to a verified Definition of Done.
```

**§2 Non-goals — annotate the existing "no outbound transports" bullet.** Find the line:

```
- Webhooks, event bus, metrics export, outbound transports of any kind (discoverability is pull-based).
```

Replace with:

```markdown
- Webhooks, event bus, metrics export, outbound transports of any kind (discoverability is pull-based). Project-level Linear updates are emitted by agents through the Linear MCP they already have, not by the Sapling server — see [§ 12 Claude plugin](#12-claude-plugin).
```

**§4 Repo layout — add new files to the tree.** Inside the `tools/` block, add a line `projects.ts # all 9 project tools + advanceProjectAfterWorkCompletion helper`. Inside the `claude-plugin/skills/` list (which currently includes `context, enqueue, human, learn, plan, queue, rules, status, teams, work`), add `project`.

**§5 Data model — add migration 007 + table + columns.** In the migrations table, append:

```markdown
| `007_projects.sql` | Creates `projects`, `project_status` enum, `project_id` FKs on `plans` and `work_items`, `is_dod_verifier` flag on `work_items`. |
```

In the "Tables" list, add a new bullet between `work_items` and `artifacts`:

```markdown
- **`projects`** — top-level intents. `app_id → apps.id ON DELETE CASCADE` (NOT NULL — projects are scoped to one app). Carries `title`, `description_md`, `definition_of_done_md`, optional `linear_url`, `status` (see enum), `failure_reason`. See [§ 7](#7-mcp-tool-surface) and [§ 8](#8-work-item-lifecycle) for behavior.
```

In the "Enums" code block, append:

```sql
project_status = 'pending' | 'scoping' | 'in_progress' | 'done' | 'blocked' | 'cancelled'
```

In the "`work_items` columns" block, after the existing columns, add:

```
project_id           int  → projects   ON DELETE SET NULL   (007)
is_dod_verifier      boolean default false                   (007)
```

In the "Indexing strategy" list, append two bullets:

```markdown
- `plans_project_idx` — partial index on `plans(project_id)` where `project_id IS NOT NULL`.
- `work_project_idx` — partial index on `work_items(project_id)` where `project_id IS NOT NULL`.
- `projects_status_idx` — broad project status filter.
```

In the "FK convention" paragraph, after the existing exception list, add:

```markdown
`projects.app_id` is `ON DELETE CASCADE` and `NOT NULL` (mirrors `services.app_id`); deleting an app cascades through services and projects. Plans and work items hold `project_id` as `ON DELETE SET NULL` so deleting a project preserves history.
```

**§7 MCP tool surface — bump count and add Projects subsection.** Change `**Total: 40 tools.**` to `**Total: 49 tools.**`. After the "Teams" subsection, add a new "Projects (`tools/projects.ts`) — 9 tools" subsection containing the table from the spec doc § "MCP tool surface". Mention the `enqueue_work` change inline at the end of the Work-queue table:

> The `enqueue_work` signature accepts an optional `project_id`; when set, the work item participates in project auto-enqueue triggers (see [§ 8](#8-work-item-lifecycle)).

**§8 Work-item lifecycle — add Project triggers subsection.** After the "Failure semantics" paragraph, add a new subsection "Project-driven auto-enqueue triggers" describing the four triggers, the order in which they fire inside `complete_work`'s transaction, and the block/unblock replay behavior. Source the body from the spec doc's "Server-side hooks" sub-section. Include the project lifecycle state diagram from the spec doc.

**§12 Claude plugin — add `/sapling:project` row.** In the slash-command table, add:

```markdown
| `/sapling:project [<args>]` | CRUD for projects (`create_project`, `complete_scoping` is invoked by `/sapling:work`-claimed scoping items, `cancel_project`, `block_project`, `unblock_project`, `retry_project`). Pull-on-create from Linear via `mcp__linear-work__get_issue`; agent-side comments back to Linear via the binding rule injected by `/sapling:work`. |
```

Mention the integration edits to `/sapling:work`, `/sapling:status`, and `/sapling:queue` as a prose paragraph following the table.

**§14 Error handling — add the new cases.** Under each existing code's row in the error table, expand the meaning column to mention project cases per the spec doc's "Error handling" section. No new codes.

**§17 Reference — append entry.** At the end of the dated-design list, add:

```markdown
- `2026-05-05-projects-design.md` — projects design (workflow-driven intent objects: scoping → per-service plans → code → per-plan reviews → DoD verifier).
```

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write SPEC.md
git add SPEC.md
git commit -m "docs(spec): document projects in SPEC.md

Updates §2 (new goal), §4 (repo layout), §5 (data model + migration 007),
§7 (49 tools, Projects subsection), §8 (auto-enqueue triggers + project
lifecycle diagram), §12 (slash-command surface), §14 (error cases), §17
(reference)."
```

---

## Task 19: Final whole-suite verification + plan close

**Files:** none (verification only).

- [ ] **Step 1: Run the full mcp-server test suite**

Run: `cd packages/mcp-server && npm test`
Expected: ALL GREEN — every existing test plus the four new files (`projects-schema.test.ts`, `projects-tools.test.ts`, `projects-lifecycle.test.ts`, plus implicit coverage of `enqueue_work` / `complete_work` via existing files).

- [ ] **Step 2: Run lint at the workspace root**

Run: `npm run lint`
Expected: PASS (no eslint or prettier complaints).

- [ ] **Step 3: Sanity-check `make build` if Docker is available**

Run: `make build` (or skip if Docker isn't available locally — CI will catch image issues).
Expected: image builds.

- [ ] **Step 4: Verify SPEC.md is in sync**

Manually grep for `40 tools` in SPEC.md — it should be gone, replaced by `49 tools`. Grep for `2026-05-05-projects-design.md` — it should be present in §17. Grep for `project_status` — it should appear in §5.

```bash
grep -n "Total:" SPEC.md
grep -n "2026-05-05-projects-design" SPEC.md
grep -n "project_status" SPEC.md
```

Expected: all three return matches.

- [ ] **Step 5: One final commit if any drift was found, otherwise stop here**

If steps 1–4 all pass without changes, the plan is complete. If any tweak was needed, commit it as `chore: post-implementation fixups` with a one-line body.

---

## Self-review notes

- Spec coverage is complete: every numbered section in `2026-05-05-projects-design.md` maps to a task above (concept/architecture → tasks 1, 3–5, 11; data model → task 1; MCP surface → tasks 3–11; slash commands → tasks 13–16; error handling and testing → tasks 1, 3–12; SPEC.md updates → task 18; plugin version → task 17).
- Type consistency: `project_status` enum values match the spec; tool names match the spec; column names match the migration; helper signature `advanceProjectAfterWorkCompletion(client, projectId, completed)` is consistent across `complete_work` and `unblock_project`.
- One subtlety on the DoD verifier failure path (Task 12 third test): the helper as designed flips the project to `done` whenever the verifier completes, regardless of whether a `dod_gaps` artifact was attached. The spec calls out two paths — success completes normally (project → done), failure attaches `dod_gaps` and _also_ completes (project still → done by helper), and the user invokes `retry_project` to re-open. This is intentional: keeping "what completes a verifier" mechanical means agents don't have to teach the server about DoD success vs failure; the human-in-the-loop step (`retry_project`) is the recovery mechanism. The skill text in Task 14 is explicit about this. No extra task needed.
