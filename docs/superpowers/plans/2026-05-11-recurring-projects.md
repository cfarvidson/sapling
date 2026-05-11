# Recurring Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cron-driven scheduler inside `mcp-server` that recurringly invokes `create_project`, with both Sapling-app and GitHub-org service sources, per-schedule overlap policy, and a `schedule_runs` audit table. Expose 8 new MCP tools and one `/sapling:schedule` plugin skill.

**Architecture:** In-process `setInterval` polls a new `schedules` table; for each due row, fires a project (optionally discovering services from a GitHub org first) and records a `schedule_runs` audit row. No new process, no new container. All control via MCP tools and the new slash command.

**Tech Stack:** TypeScript + Node 22 ESM, Postgres 16, `cron-parser` for cron, `@octokit/rest` for GitHub, `pino` for logs, `zod` for input validation, vitest + testcontainers + in-memory MCP client for tests.

**Spec reference:** `docs/superpowers/specs/2026-05-11-recurring-projects-design.md`.

**Important codebase notes (read these before starting):**

- The repo's `AppError` codes are `'invalid_input' | 'not_found' | 'conflict' | 'claim_race' | 'internal'` (see `packages/mcp-server/src/errors.ts`). The spec used the word "bad_request" — use **`invalid_input`** in code.
- Tools are registered via `server.registerTool(name, { description, inputSchema }, handler)` where `inputSchema` is a flat object of zod schemas, not a wrapped `z.object`.
- The `pg.Pool` is typed as `Db`. Transactional code uses `withTx(pool, async (client) => …)` from `src/db.ts`. Multi-statement code that needs explicit rollback control (which the scheduler needs) uses `await client.query('BEGIN' / 'ROLLBACK' / 'COMMIT')` directly, the same pattern as `projects.ts`.
- All new code lives under `packages/mcp-server/src/` and `packages/claude-plugin/skills/`. The plugin's `plugin.json` version is at `packages/claude-plugin/.claude-plugin/plugin.json`.
- Per `CLAUDE.md`, **SPEC.md and `plugin.json` updates land in the same PR** as the implementation. They're concentrated in the final two tasks (15 and 16) for clarity, but reviewers should treat them as part of the same logical change.
- Run all tests with `make test` (which runs `pnpm --filter mcp-server test` then `pnpm --filter sapling-runner test`). Individual files: `pnpm --filter mcp-server test -- test/integration/schedules-crud.test.ts`.

**File structure being created or modified:**

- Create: `packages/mcp-server/src/schema/011_schedules.sql`
- Create: `packages/mcp-server/src/cron.ts`
- Create: `packages/mcp-server/src/github.ts`
- Create: `packages/mcp-server/src/schedules/db.ts` (typed CRUD against the schedules tables)
- Create: `packages/mcp-server/src/schedules/services.ts` (find-or-create services from discovered repos)
- Create: `packages/mcp-server/src/schedules/fire.ts` (overlap check + project insertion + run recording for one fire)
- Create: `packages/mcp-server/src/schedules/scheduler.ts` (tick loop + `startScheduler`)
- Create: `packages/mcp-server/src/tools/schedules.ts` (8 new MCP tools)
- Modify: `packages/mcp-server/src/tools/projects.ts` (extract `createProjectInTx` for reuse by the fire path)
- Modify: `packages/mcp-server/src/tools/register.ts` (register `schedules` tools)
- Modify: `packages/mcp-server/src/tools/runner_config.ts` (add `github_token` + `github_default_visibility`, redact token on read)
- Modify: `packages/mcp-server/src/config.ts` (add `SCHEDULER_TICK_MS`)
- Modify: `packages/mcp-server/src/index.ts` (start scheduler after migrations)
- Modify: `packages/mcp-server/package.json` (add `cron-parser` and `@octokit/rest`)
- Create: `packages/mcp-server/test/__mocks__/@octokit/rest.ts` (mock Octokit for tests)
- Create: `packages/mcp-server/test/unit/cron.test.ts`
- Create: `packages/mcp-server/test/integration/schedules-migration.test.ts`
- Create: `packages/mcp-server/test/integration/schedules-crud.test.ts`
- Create: `packages/mcp-server/test/integration/schedules-fire-app.test.ts`
- Create: `packages/mcp-server/test/integration/schedules-fire-github.test.ts`
- Create: `packages/mcp-server/test/integration/scheduler-tick.test.ts`
- Modify: `packages/mcp-server/test/integration/runner_config.test.ts` (assert `github_token` redaction)
- Create: `packages/claude-plugin/skills/schedule/SKILL.md`
- Modify: `packages/claude-plugin/skills/status/SKILL.md` (schedule section)
- Modify: `packages/claude-plugin/.claude-plugin/plugin.json` (version bump)
- Modify: `SPEC.md` (sections 3, 5, 7, 13, 2)
- Modify: `README.md` (recurring projects subsection)

---

## Task 1: Migration 011 — `schedules`, `schedule_runs`, `runner_config` extensions

**Files:**
- Create: `packages/mcp-server/src/schema/011_schedules.sql`
- Create: `packages/mcp-server/test/integration/schedules-migration.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `packages/mcp-server/test/integration/schedules-migration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('migration 011 schedules', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  it('creates schedules and schedule_runs tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('schedules','schedule_runs')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(['schedule_runs', 'schedules']);
  });

  it('adds github_token and github_default_visibility to runner_config', async () => {
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='runner_config'
          AND column_name IN ('github_token','github_default_visibility')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'github_default_visibility',
      'github_token',
    ]);
  });

  it('rejects schedules with mismatched source_type/github_org', async () => {
    // Seed an app + a cron-ish next_run_at
    const { rows: appRows } = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('mig011-app') RETURNING id`,
    );
    const appId = appRows[0].id;
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, github_org, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('s1', 'app', $1, 'should-be-null', '0 * * * *',
                 't', 'd', 'dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, github_org, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('s2', 'github_org', $1, NULL, '0 * * * *',
                 't', 'd', 'dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE on schedules.name', async () => {
    const { rows: appRows } = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('mig011-app2') RETURNING id`,
    );
    const appId = appRows[0].id;
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, title_template,
          description_md, definition_of_done_md, next_run_at)
       VALUES ('dup-name','app',$1,'0 * * * *','t','d','dod', now())`,
      [appId],
    );
    await expect(
      db.pool.query(
        `INSERT INTO schedules
           (name, source_type, app_id, cron_expr, title_template,
            description_md, definition_of_done_md, next_run_at)
         VALUES ('dup-name','app',$1,'0 * * * *','t','d','dod', now())`,
        [appId],
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-migration.test.ts`
Expected: FAIL — `relation "schedules" does not exist`.

- [ ] **Step 3: Write the migration**

Create `packages/mcp-server/src/schema/011_schedules.sql`:

```sql
CREATE TYPE schedule_source AS ENUM ('app', 'github_org');
CREATE TYPE schedule_overlap AS ENUM ('skip_if_running', 'always_fire');
CREATE TYPE schedule_run_status AS ENUM ('fired', 'skipped_overlap', 'failed');

CREATE TABLE IF NOT EXISTS schedules (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL UNIQUE,
  source_type              schedule_source NOT NULL,
  app_id                   INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_org               TEXT,
  cron_expr                TEXT NOT NULL,
  timezone                 TEXT NOT NULL DEFAULT 'UTC',
  overlap_policy           schedule_overlap NOT NULL DEFAULT 'skip_if_running',
  title_template           TEXT NOT NULL,
  description_md           TEXT NOT NULL,
  definition_of_done_md    TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at            TIMESTAMPTZ,
  next_run_at              TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_type = 'app'        AND github_org IS NULL)
    OR (source_type = 'github_org' AND github_org IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules(next_run_at) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id            SERIAL PRIMARY KEY,
  schedule_id   INT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        schedule_run_status NOT NULL,
  project_id    INT REFERENCES projects(id) ON DELETE SET NULL,
  error         TEXT,
  duration_ms   INT
);

CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx
  ON schedule_runs(schedule_id, fired_at DESC);

ALTER TABLE runner_config
  ADD COLUMN IF NOT EXISTS github_token              TEXT,
  ADD COLUMN IF NOT EXISTS github_default_visibility TEXT NOT NULL DEFAULT 'all';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/schema/011_schedules.sql \
        packages/mcp-server/test/integration/schedules-migration.test.ts
git commit -m "feat(mcp-server): migration 011 — schedules + schedule_runs + runner_config github fields"
```

---

## Task 2: Cron + timezone helper module

**Files:**
- Create: `packages/mcp-server/src/cron.ts`
- Create: `packages/mcp-server/test/unit/cron.test.ts`
- Modify: `packages/mcp-server/package.json` (add `cron-parser`)

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter mcp-server add cron-parser
```

This adds `cron-parser` to `dependencies` in `packages/mcp-server/package.json`.

- [ ] **Step 2: Write the failing tests**

Create `packages/mcp-server/test/unit/cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextCronTick, validateCron, validateTimezone } from '../../src/cron.js';

describe('cron helpers', () => {
  it('nextCronTick returns the next minute boundary for "* * * * *"', () => {
    const from = new Date('2026-05-11T12:00:00Z');
    const next = nextCronTick('* * * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-05-11T12:01:00.000Z');
  });

  it('nextCronTick honours the timezone (9am Stockholm = 07:00 UTC in winter)', () => {
    const from = new Date('2026-01-15T06:30:00Z');
    const next = nextCronTick('0 9 * * *', 'Europe/Stockholm', from);
    // Stockholm is UTC+1 in January → 09:00 Stockholm = 08:00 UTC
    expect(next.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('validateCron returns null for valid 5-field expressions', () => {
    expect(validateCron('0 * * * *')).toBeNull();
    expect(validateCron('*/15 9-17 * * 1-5')).toBeNull();
  });

  it('validateCron returns an error string for invalid expressions', () => {
    expect(validateCron('not-cron')).toMatch(/cron/i);
    expect(validateCron('')).toMatch(/cron/i);
  });

  it('validateCron rejects 6-field (seconds) cron', () => {
    expect(validateCron('0 0 * * * *')).toMatch(/5-field|invalid/i);
  });

  it('validateTimezone accepts IANA zones and rejects others', () => {
    expect(validateTimezone('UTC')).toBeNull();
    expect(validateTimezone('Europe/Stockholm')).toBeNull();
    expect(validateTimezone('Mars/Olympus')).toMatch(/timezone|invalid/i);
    expect(validateTimezone('')).toMatch(/timezone|invalid/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter mcp-server test -- test/unit/cron.test.ts`
Expected: FAIL — `Cannot find module '../../src/cron.js'`.

- [ ] **Step 4: Write the helper**

Create `packages/mcp-server/src/cron.ts`:

```ts
import { CronExpressionParser } from 'cron-parser';

export function validateCron(expr: string): string | null {
  if (!expr || typeof expr !== 'string') return 'cron expression must be a non-empty string';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return 'cron expression must have exactly 5 fields (m h dom mon dow)';
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (err) {
    return `invalid cron expression: ${(err as Error).message}`;
  }
}

export function validateTimezone(tz: string): string | null {
  if (!tz || typeof tz !== 'string') return 'timezone must be a non-empty string';
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return null;
  } catch {
    return `invalid timezone: ${tz}`;
  }
}

export function nextCronTick(expr: string, tz: string, from: Date): Date {
  const iter = CronExpressionParser.parse(expr, { currentDate: from, tz });
  return iter.next().toDate();
}

export function nextNCronTicks(expr: string, tz: string, from: Date, n: number): Date[] {
  const iter = CronExpressionParser.parse(expr, { currentDate: from, tz });
  const out: Date[] = [];
  for (let i = 0; i < n; i++) out.push(iter.next().toDate());
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter mcp-server test -- test/unit/cron.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/cron.ts \
        packages/mcp-server/test/unit/cron.test.ts \
        packages/mcp-server/package.json \
        pnpm-lock.yaml
git commit -m "feat(mcp-server): cron + timezone helper using cron-parser"
```

---

## Task 3: Extend `runner_config` tools with `github_token` and `github_default_visibility`

**Files:**
- Modify: `packages/mcp-server/src/tools/runner_config.ts`
- Modify: `packages/mcp-server/test/integration/runner_config.test.ts`

- [ ] **Step 1: Add failing tests for the new fields and redaction**

Append these `it(...)` cases to the end of `packages/mcp-server/test/integration/runner_config.test.ts`'s `describe` block:

```ts
  it('redacts github_token on get_runner_config when set', async () => {
    await client.call('update_runner_config', { github_token: 'ghp_secret_xyz' });
    const out = (await client.call('get_runner_config', {})) as Record<string, unknown>;
    expect(out.github_token).toBe('***');
  });

  it('returns null github_token when unset', async () => {
    const out = (await client.call('get_runner_config', {})) as Record<string, unknown>;
    expect(out.github_token).toBeNull();
  });

  it('accepts null github_token to clear it', async () => {
    await client.call('update_runner_config', { github_token: 'ghp_x' });
    const out = (await client.call('update_runner_config', { github_token: null })) as Record<
      string,
      unknown
    >;
    expect(out.github_token).toBeNull();
  });

  it('accepts github_default_visibility and rejects unknown values', async () => {
    const out = (await client.call('update_runner_config', {
      github_default_visibility: 'public',
    })) as Record<string, unknown>;
    expect(out.github_default_visibility).toBe('public');
    const raw = await client.callRaw('update_runner_config', {
      github_default_visibility: 'sometimes',
    });
    expect(raw.isError).toBe(true);
  });
```

Also update the existing `seeds exactly one row with documented defaults` test to assert the new defaults:

```ts
    expect(cfg.github_token).toBeNull();
    expect((cfg as Record<string, unknown>).github_default_visibility).toBe('all');
```

And update the `beforeEach` reset query to also reset the new fields:

```ts
              ntfy_url = NULL,
              awaiting_input_nag_age_ms = DEFAULT,
              awaiting_input_nag_repeat_ms = DEFAULT,
              github_token = NULL,
              github_default_visibility = DEFAULT,
              updated_at = now()
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm --filter mcp-server test -- test/integration/runner_config.test.ts`
Expected: FAIL — `github_default_visibility` not accepted; `github_token` not redacted.

- [ ] **Step 3: Update the tool**

Edit `packages/mcp-server/src/tools/runner_config.ts`:

1. Replace the entire body of the `get_runner_config` handler with:

```ts
    async () => {
      const { rows } = await db.query(`SELECT * FROM runner_config WHERE id = 1`);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', 'runner_config row missing'));
      const row = { ...rows[0] };
      if (row.github_token != null) row.github_token = '***';
      return ok(row);
    },
```

2. Extend the `update_runner_config` `inputSchema`:

```ts
        github_token: z.string().min(1).nullable().optional(),
        github_default_visibility: z.enum(['all', 'public', 'private']).optional(),
```

3. Extend the `fields` array inside the handler:

```ts
      const fields: Array<keyof typeof input> = [
        'agent_command',
        'max_concurrent',
        'poll_interval_ms',
        'claim_ttl_ms',
        'max_claim_attempts',
        'ntfy_url',
        'awaiting_input_nag_age_ms',
        'awaiting_input_nag_repeat_ms',
        'github_token',
        'github_default_visibility',
      ];
```

4. Redact `github_token` on the `RETURNING` row as well:

```ts
        const row = { ...rows[0] };
        if (row.github_token != null) row.github_token = '***';
        return ok(row);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter mcp-server test -- test/integration/runner_config.test.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/runner_config.ts \
        packages/mcp-server/test/integration/runner_config.test.ts
git commit -m "feat(mcp-server): update_runner_config accepts github_token + github_default_visibility; redact token on read"
```

---

## Task 4: Extract `createProjectInTx` for reuse by the scheduler

The fire path needs to call the same project-creation logic the `create_project` MCP tool uses, but inside a transaction the scheduler controls (so the project insert and the `schedule_runs` insert are atomic). Extract the body of the `create_project` handler into a reusable helper that takes a `PoolClient` and returns the created project; the MCP tool becomes a thin wrapper around it.

**Files:**
- Modify: `packages/mcp-server/src/tools/projects.ts`

- [ ] **Step 1: Add a failing test for the extracted helper**

Append a new test file: `packages/mcp-server/test/integration/projects-in-tx.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { createProjectInTx } from '../../src/tools/projects.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('createProjectInTx (extracted helper)', () => {
  let db: TestDb;
  let appId: number;
  let svc1: number;
  let svc2: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('helper-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    const s1 = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc-1') RETURNING id`,
      [appId],
    );
    svc1 = s1.rows[0].id;
    const s2 = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc-2') RETURNING id`,
      [appId],
    );
    svc2 = s2.rows[0].id;
  });

  it('creates a project with service fan-out in a caller-supplied transaction', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createProjectInTx(client, {
        app_id: appId,
        app_name: 'helper-app',
        title: 'Weekly review',
        description_md: 'review the repos',
        definition_of_done_md: 'reviews posted to each repo',
        service_ids: [svc1, svc2],
      });
      await client.query('COMMIT');
      expect(result.project.status).toBe('in_progress');
      expect(result.plan_work_items).toHaveLength(2);
    } finally {
      client.release();
    }
  });

  it('returns a scoping work item when no service_ids supplied', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createProjectInTx(client, {
        app_id: appId,
        app_name: 'helper-app',
        title: 'Unscoped',
        description_md: 'figure it out',
        definition_of_done_md: 'done is done',
      });
      await client.query('COMMIT');
      expect(result.project.status).toBe('scoping');
      expect(result.scoping_work).toBeTruthy();
    } finally {
      client.release();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test -- test/integration/projects-in-tx.test.ts`
Expected: FAIL — `createProjectInTx` is not exported.

- [ ] **Step 3: Refactor `projects.ts` to extract the helper**

In `packages/mcp-server/src/tools/projects.ts`:

1. Add this exported function above `registerProjects`:

```ts
export interface CreateProjectInput {
  app_id: number;
  app_name: string;             // for diagnostic messages
  title: string;
  description_md: string;
  definition_of_done_md: string;
  linear_url?: string;
  service_ids?: number[];
}

export interface CreateProjectResult {
  project: Record<string, unknown>;
  scoping_work?: Record<string, unknown>;
  plan_work_items?: Record<string, unknown>[];
}

export async function createProjectInTx(
  client: PoolClient,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  if (!input.definition_of_done_md.trim()) {
    throw new AppError('invalid_input', 'definition_of_done_md must not be empty');
  }

  const fastPath = (input.service_ids?.length ?? 0) > 0;
  if (fastPath) {
    const services = await client.query<{ id: number; app_id: number; name: string }>(
      `SELECT id, app_id, name FROM services WHERE id = ANY($1::int[])`,
      [input.service_ids],
    );
    if (services.rowCount !== input.service_ids!.length) {
      throw new AppError('not_found', 'one or more service_ids not found');
    }
    const wrong = services.rows.find((s) => s.app_id !== input.app_id);
    if (wrong) {
      throw new AppError(
        'invalid_input',
        `service ${wrong.id} (${wrong.name}) does not belong to app ${input.app_name}`,
      );
    }
  }

  const initialStatus = fastPath ? 'in_progress' : 'scoping';
  const projInsert = await client.query(
    `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, linear_url, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.app_id,
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
       VALUES ('plan', $1, $2, $3) RETURNING *`,
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
    return { project, scoping_work: scoping.rows[0] };
  }

  const planWorkItems: Record<string, unknown>[] = [];
  for (const serviceId of input.service_ids!) {
    const plan = await client.query(
      `INSERT INTO work_items(type, title, description_markdown, service_id, project_id)
       VALUES ('plan', $1, $2, $3, $4) RETURNING *`,
      [
        `Plan work for project ${project.id} on service ${serviceId}`,
        `Plan work for project ${project.id} on service ${serviceId}.\n\n` +
          `Description:\n\n${project.description_md}\n\n` +
          `Definition of Done:\n\n${project.definition_of_done_md}`,
        serviceId,
        project.id,
      ],
    );
    planWorkItems.push(plan.rows[0]);
  }
  return { project, plan_work_items: planWorkItems };
}
```

> **Note:** The exact plan-work-item insert SQL above matches the spirit of the existing `create_project` handler. When extracting, **copy the existing implementation verbatim** from the current `registerProjects` body (lines ~100–180 of `projects.ts`) into this helper rather than re-deriving it — there may be subtleties (artifact links, project-id wiring) that this plan summary doesn't enumerate.

2. Replace the body of the `create_project` `registerTool` handler with a thin wrapper:

```ts
    async (input) => {
      try {
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
          const result = await createProjectInTx(client, {
            app_id: appId,
            app_name: input.app_name,
            title: input.title,
            description_md: input.description_md,
            definition_of_done_md: input.definition_of_done_md,
            linear_url: input.linear_url,
            service_ids: input.service_ids,
          });
          await client.query('COMMIT');
          return ok(result);
        } catch (err) {
          await client.query('ROLLBACK');
          if (err instanceof AppError) return errorToToolResult(err);
          return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
        } finally {
          client.release();
        }
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
```

- [ ] **Step 4: Run the full project + new helper test suite**

Run: `pnpm --filter mcp-server test -- test/integration/projects-in-tx.test.ts test/integration/projects-lifecycle.test.ts test/integration/projects-tools.test.ts`
Expected: PASS for all suites. If any existing project test fails, the refactor diverged from the original behavior — diff against `git show HEAD:packages/mcp-server/src/tools/projects.ts` and align.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/projects.ts \
        packages/mcp-server/test/integration/projects-in-tx.test.ts
git commit -m "refactor(mcp-server): extract createProjectInTx for reuse by scheduler"
```

---

## Task 5: Schedule DB helpers

Typed CRUD against `schedules` and `schedule_runs`. Used by both the tool layer (Task 6) and the fire path (Task 9).

**Files:**
- Create: `packages/mcp-server/src/schedules/db.ts`

- [ ] **Step 1: Write the helper module**

Create `packages/mcp-server/src/schedules/db.ts`:

```ts
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';

export type ScheduleSource = 'app' | 'github_org';
export type ScheduleOverlap = 'skip_if_running' | 'always_fire';
export type ScheduleRunStatus = 'fired' | 'skipped_overlap' | 'failed';

export interface ScheduleRow {
  id: number;
  name: string;
  source_type: ScheduleSource;
  app_id: number;
  github_org: string | null;
  cron_expr: string;
  timezone: string;
  overlap_policy: ScheduleOverlap;
  title_template: string;
  description_md: string;
  definition_of_done_md: string;
  enabled: boolean;
  last_fired_at: Date | null;
  next_run_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleRunRow {
  id: number;
  schedule_id: number;
  fired_at: Date;
  status: ScheduleRunStatus;
  project_id: number | null;
  error: string | null;
  duration_ms: number | null;
}

export async function findScheduleByIdOrName(
  db: Db | PoolClient,
  idOrName: number | string,
): Promise<ScheduleRow | null> {
  const sql =
    typeof idOrName === 'number'
      ? `SELECT * FROM schedules WHERE id = $1`
      : `SELECT * FROM schedules WHERE name = $1`;
  const { rows } = await db.query<ScheduleRow>(sql, [idOrName]);
  return rows[0] ?? null;
}

export async function listSchedules(
  db: Db,
  filters: { app_id?: number; source_type?: ScheduleSource; enabled?: boolean },
): Promise<ScheduleRow[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (filters.app_id !== undefined) {
    vals.push(filters.app_id);
    conds.push(`app_id = $${vals.length}`);
  }
  if (filters.source_type !== undefined) {
    vals.push(filters.source_type);
    conds.push(`source_type = $${vals.length}`);
  }
  if (filters.enabled !== undefined) {
    vals.push(filters.enabled);
    conds.push(`enabled = $${vals.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await db.query<ScheduleRow>(
    `SELECT * FROM schedules ${where} ORDER BY id ASC`,
    vals,
  );
  return rows;
}

export async function recordRun(
  client: PoolClient,
  args: {
    schedule_id: number;
    status: ScheduleRunStatus;
    project_id?: number | null;
    error?: string | null;
    duration_ms?: number | null;
  },
): Promise<ScheduleRunRow> {
  const { rows } = await client.query<ScheduleRunRow>(
    `INSERT INTO schedule_runs(schedule_id, status, project_id, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      args.schedule_id,
      args.status,
      args.project_id ?? null,
      args.error ?? null,
      args.duration_ms ?? null,
    ],
  );
  return rows[0];
}

export async function recentRuns(
  db: Db | PoolClient,
  schedule_id: number,
  limit: number,
): Promise<ScheduleRunRow[]> {
  const { rows } = await db.query<ScheduleRunRow>(
    `SELECT * FROM schedule_runs WHERE schedule_id = $1
      ORDER BY fired_at DESC LIMIT $2`,
    [schedule_id, limit],
  );
  return rows;
}

export async function advanceNextRun(
  client: PoolClient,
  schedule_id: number,
  next_run_at: Date,
  fired: boolean,
): Promise<void> {
  if (fired) {
    await client.query(
      `UPDATE schedules SET last_fired_at = now(), next_run_at = $2, updated_at = now()
        WHERE id = $1`,
      [schedule_id, next_run_at],
    );
  } else {
    await client.query(
      `UPDATE schedules SET next_run_at = $2, updated_at = now() WHERE id = $1`,
      [schedule_id, next_run_at],
    );
  }
}
```

- [ ] **Step 2: Commit (no tests yet — covered by Tasks 6 and 9)**

```bash
git add packages/mcp-server/src/schedules/db.ts
git commit -m "feat(mcp-server): typed CRUD helpers for schedules + schedule_runs"
```

---

## Task 6: Schedule CRUD MCP tools

Tools: `create_schedule`, `get_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`, `enable_schedule`, `disable_schedule`. The 8th tool (`run_schedule_now`) lands in Task 10 because it depends on the fire path.

**Files:**
- Create: `packages/mcp-server/src/tools/schedules.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`
- Create: `packages/mcp-server/test/integration/schedules-crud.test.ts`

- [ ] **Step 1: Write the failing CRUD tests**

Create `packages/mcp-server/test/integration/schedules-crud.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('schedule CRUD tools', () => {
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
    await db.pool.query(`TRUNCATE schedules, schedule_runs RESTART IDENTITY CASCADE`);
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    await db.pool.query(`INSERT INTO apps(name) VALUES ('crud-app')`);
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  const valid = {
    name: 's1',
    source_type: 'app' as const,
    app_name: 'crud-app',
    cron_expr: '0 9 * * 1-5',
    timezone: 'Europe/Stockholm',
    title_template: 'Weekly review {{date}}',
    description_md: 'review repos',
    definition_of_done_md: 'reviews posted',
  };

  it('create_schedule happy path computes next_run_at', async () => {
    const out = (await client.call('create_schedule', valid)) as {
      id: number;
      next_run_at: string;
    };
    expect(out.id).toBeTypeOf('number');
    expect(new Date(out.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects invalid cron with invalid_input', async () => {
    const raw = await client.callRaw('create_schedule', { ...valid, cron_expr: 'nope' });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/cron/i);
  });

  it('rejects unknown timezone with invalid_input', async () => {
    const raw = await client.callRaw('create_schedule', { ...valid, timezone: 'Mars/Olympus' });
    expect(raw.isError).toBe(true);
  });

  it('rejects github_org source without github_org string', async () => {
    const raw = await client.callRaw('create_schedule', {
      ...valid,
      name: 's-no-org',
      source_type: 'github_org',
    });
    expect(raw.isError).toBe(true);
  });

  it('name uniqueness returns conflict', async () => {
    await client.call('create_schedule', valid);
    const raw = await client.callRaw('create_schedule', valid);
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/conflict|exists|unique/i);
  });

  it('get_schedule returns schedule + last_run + last_5_runs + next 3 ticks', async () => {
    const created = (await client.call('create_schedule', valid)) as { id: number };
    const out = (await client.call('get_schedule', { id_or_name: created.id })) as {
      schedule: { id: number };
      last_run: unknown | null;
      last_5_runs: unknown[];
      next_3_fires: string[];
    };
    expect(out.schedule.id).toBe(created.id);
    expect(out.last_run).toBeNull();
    expect(out.last_5_runs).toEqual([]);
    expect(out.next_3_fires).toHaveLength(3);
  });

  it('list_schedules filters by app_name and enabled', async () => {
    await client.call('create_schedule', valid);
    await client.call('create_schedule', { ...valid, name: 's2' });
    const all = (await client.call('list_schedules', {})) as unknown[];
    expect(all).toHaveLength(2);
    const filtered = (await client.call('list_schedules', { app_name: 'crud-app' })) as unknown[];
    expect(filtered).toHaveLength(2);
  });

  it('update_schedule recomputes next_run_at when cron_expr changes', async () => {
    const created = (await client.call('create_schedule', valid)) as {
      id: number;
      next_run_at: string;
    };
    const before = new Date(created.next_run_at).getTime();
    const updated = (await client.call('update_schedule', {
      id: created.id,
      cron_expr: '*/5 * * * *',
    })) as { next_run_at: string };
    expect(new Date(updated.next_run_at).getTime()).not.toBe(before);
  });

  it('update_schedule rejects non-patchable fields', async () => {
    const created = (await client.call('create_schedule', valid)) as { id: number };
    const raw = await client.callRaw('update_schedule', {
      id: created.id,
      name: 'new-name',
    });
    expect(raw.isError).toBe(true);
  });

  it('enable/disable flips the flag and recomputes next_run_at on re-enable', async () => {
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await client.call('disable_schedule', { id: c.id });
    const off = (await client.call('get_schedule', { id_or_name: c.id })) as {
      schedule: { enabled: boolean };
    };
    expect(off.schedule.enabled).toBe(false);
    await client.call('enable_schedule', { id: c.id });
    const on = (await client.call('get_schedule', { id_or_name: c.id })) as {
      schedule: { enabled: boolean; next_run_at: string };
    };
    expect(on.schedule.enabled).toBe(true);
    expect(new Date(on.schedule.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('delete_schedule cascades schedule_runs but not projects', async () => {
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await db.pool.query(
      `INSERT INTO schedule_runs(schedule_id, status) VALUES ($1, 'fired')`,
      [c.id],
    );
    await client.call('delete_schedule', { id: c.id });
    const { rowCount } = await db.pool.query(`SELECT 1 FROM schedule_runs WHERE schedule_id = $1`, [
      c.id,
    ]);
    expect(rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-crud.test.ts`
Expected: FAIL — `Unknown tool: create_schedule`.

- [ ] **Step 3: Write the tool module**

Create `packages/mcp-server/src/tools/schedules.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';
import { nextCronTick, nextNCronTicks, validateCron, validateTimezone } from '../cron.js';
import {
  findScheduleByIdOrName,
  listSchedules,
  recentRuns,
} from '../schedules/db.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const Visibility = z.enum(['all', 'public', 'private']);

const CreateInput = {
  name: z.string().min(1),
  source_type: z.enum(['app', 'github_org']),
  app_name: z.string().min(1),
  github_org: z.string().min(1).optional(),
  cron_expr: z.string().min(1),
  timezone: z.string().default('UTC'),
  overlap_policy: z.enum(['skip_if_running', 'always_fire']).default('skip_if_running'),
  title_template: z.string().min(1),
  description_md: z.string().min(1),
  definition_of_done_md: z.string().min(1),
};

const UpdateInput = {
  id: z.number().int().positive(),
  cron_expr: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  overlap_policy: z.enum(['skip_if_running', 'always_fire']).optional(),
  title_template: z.string().min(1).optional(),
  description_md: z.string().min(1).optional(),
  definition_of_done_md: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
};

export function registerSchedules(server: McpServer, db: Db): void {
  server.registerTool(
    'create_schedule',
    {
      description:
        'Create a recurring project schedule. source_type="app" runs against existing services; ' +
        '"github_org" discovers repos live from a GitHub org at fire time (requires runner_config.github_token).',
      inputSchema: CreateInput,
    },
    async (input) => {
      const cronErr = validateCron(input.cron_expr);
      if (cronErr) return errorToToolResult(new AppError('invalid_input', cronErr));
      const tzErr = validateTimezone(input.timezone);
      if (tzErr) return errorToToolResult(new AppError('invalid_input', tzErr));
      if (input.source_type === 'github_org' && !input.github_org) {
        return errorToToolResult(
          new AppError('invalid_input', 'github_org is required when source_type=github_org'),
        );
      }

      const app = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
        input.app_name,
      ]);
      if (app.rowCount === 0)
        return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));

      const next = nextCronTick(input.cron_expr, input.timezone, new Date());
      try {
        const { rows } = await db.query(
          `INSERT INTO schedules
             (name, source_type, app_id, github_org, cron_expr, timezone, overlap_policy,
              title_template, description_md, definition_of_done_md, next_run_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            input.name,
            input.source_type,
            app.rows[0].id,
            input.source_type === 'github_org' ? input.github_org : null,
            input.cron_expr,
            input.timezone,
            input.overlap_policy,
            input.title_template,
            input.description_md,
            input.definition_of_done_md,
            next,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_schedule',
    {
      description:
        'Fetch a schedule plus last run, last 5 runs, and the next 3 cron fire times.',
      inputSchema: {
        id_or_name: z.union([z.number().int().positive(), z.string().min(1)]),
      },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id_or_name);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const runs = await recentRuns(db, sched.id, 5);
      const next3 = nextNCronTicks(sched.cron_expr, sched.timezone, new Date(), 3);
      return ok({
        schedule: sched,
        last_run: runs[0] ?? null,
        last_5_runs: runs,
        next_3_fires: next3.map((d) => d.toISOString()),
      });
    },
  );

  server.registerTool(
    'list_schedules',
    {
      description:
        'List schedules. Optional filters: app_name, source_type, enabled. Returns full rows.',
      inputSchema: {
        app_name: z.string().min(1).optional(),
        source_type: z.enum(['app', 'github_org']).optional(),
        enabled: z.boolean().optional(),
      },
    },
    async (input) => {
      let appId: number | undefined;
      if (input.app_name) {
        const a = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          input.app_name,
        ]);
        if (a.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        appId = a.rows[0].id;
      }
      const rows = await listSchedules(db, {
        app_id: appId,
        source_type: input.source_type,
        enabled: input.enabled,
      });
      return ok(rows);
    },
  );

  server.registerTool(
    'update_schedule',
    {
      description:
        'Patch a schedule. source_type, app_id, github_org, name are NOT patchable — recreate. ' +
        'Changing cron_expr or timezone recomputes next_run_at.',
      inputSchema: UpdateInput,
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));

      const sets: string[] = [];
      const vals: unknown[] = [];
      const patchable = [
        'cron_expr',
        'timezone',
        'overlap_policy',
        'title_template',
        'description_md',
        'definition_of_done_md',
        'enabled',
      ] as const;
      for (const k of patchable) {
        const v = input[k];
        if (v === undefined) continue;
        if (k === 'cron_expr') {
          const err = validateCron(v as string);
          if (err) return errorToToolResult(new AppError('invalid_input', err));
        }
        if (k === 'timezone') {
          const err = validateTimezone(v as string);
          if (err) return errorToToolResult(new AppError('invalid_input', err));
        }
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
      if (sets.length === 0)
        return errorToToolResult(
          new AppError('invalid_input', 'update_schedule requires at least one patchable field'),
        );

      const newCron = input.cron_expr ?? sched.cron_expr;
      const newTz = input.timezone ?? sched.timezone;
      const next = nextCronTick(newCron, newTz, new Date());
      vals.push(next);
      sets.push(`next_run_at = $${vals.length}`);
      sets.push(`updated_at = now()`);

      vals.push(sched.id);
      const { rows } = await db.query(
        `UPDATE schedules SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
        vals,
      );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'delete_schedule',
    {
      description: 'Hard delete a schedule. Cascades schedule_runs. Does not touch spawned projects.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const { rowCount } = await db.query(`DELETE FROM schedules WHERE id = $1`, [input.id]);
      if (rowCount === 0)
        return errorToToolResult(new AppError('not_found', 'schedule not found'));
      return ok({ deleted: input.id });
    },
  );

  server.registerTool(
    'enable_schedule',
    {
      description: 'Enable a schedule. Recomputes next_run_at from now. Does not catch up.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const next = nextCronTick(sched.cron_expr, sched.timezone, new Date());
      const { rows } = await db.query(
        `UPDATE schedules SET enabled = TRUE, next_run_at = $2, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [input.id, next],
      );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'disable_schedule',
    {
      description: 'Disable a schedule. In-flight spawned projects are NOT cancelled.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const { rows, rowCount } = await db.query(
        `UPDATE schedules SET enabled = FALSE, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [input.id],
      );
      if (rowCount === 0)
        return errorToToolResult(new AppError('not_found', 'schedule not found'));
      return ok(rows[0]);
    },
  );

  // run_schedule_now is registered in Task 10 once the fire path exists.
}

export { Visibility };
```

- [ ] **Step 4: Register the new tools**

Edit `packages/mcp-server/src/tools/register.ts` — add the import and call:

```ts
import { registerSchedules } from './schedules.js';
// …
export function registerAllTools(server: McpServer, db: Db): void {
  // …
  registerProjects(server, db);
  registerSchedules(server, db);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-crud.test.ts`
Expected: PASS (all 11 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools/schedules.ts \
        packages/mcp-server/src/tools/register.ts \
        packages/mcp-server/test/integration/schedules-crud.test.ts
git commit -m "feat(mcp-server): schedule CRUD tools (create/get/list/update/delete/enable/disable)"
```

---

## Task 7: GitHub helper module

A thin wrapper around `@octokit/rest` for listing org repos. Mocked in tests.

**Files:**
- Create: `packages/mcp-server/src/github.ts`
- Create: `packages/mcp-server/test/__mocks__/@octokit/rest.ts`
- Create: `packages/mcp-server/test/unit/github.test.ts`
- Modify: `packages/mcp-server/package.json` (add `@octokit/rest`)

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter mcp-server add @octokit/rest
```

- [ ] **Step 2: Create the Octokit mock module**

Create `packages/mcp-server/test/__mocks__/@octokit/rest.ts`:

```ts
import { vi } from 'vitest';

export type FakeRepo = {
  name: string;
  clone_url: string;
  default_branch: string;
  archived: boolean;
};

// State injected by tests.
export const __state = {
  repos: [] as FakeRepo[],
  shouldThrow: undefined as Error | undefined,
  lastTokenSeen: undefined as string | undefined,
  lastOrgSeen: undefined as string | undefined,
};

export function __resetMock() {
  __state.repos = [];
  __state.shouldThrow = undefined;
  __state.lastTokenSeen = undefined;
  __state.lastOrgSeen = undefined;
}

export const Octokit = vi.fn().mockImplementation((opts: { auth?: string } = {}) => {
  __state.lastTokenSeen = opts.auth;
  return {
    paginate: vi.fn(async (_endpoint: unknown, params: { org: string; per_page?: number }) => {
      __state.lastOrgSeen = params.org;
      if (__state.shouldThrow) throw __state.shouldThrow;
      return [...__state.repos];
    }),
    rest: {
      repos: {
        listForOrg: vi.fn(),
      },
    },
  };
});
```

- [ ] **Step 3: Write failing tests for the GitHub helper**

Create `packages/mcp-server/test/unit/github.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/rest');

import { __resetMock, __state } from '../__mocks__/@octokit/rest.js';
import { listOrgRepos } from '../../src/github.js';

describe('listOrgRepos', () => {
  beforeEach(() => {
    __resetMock();
  });

  it('passes the token to Octokit and the org to paginate', async () => {
    __state.repos = [
      { name: 'r1', clone_url: 'https://github.com/org/r1.git', default_branch: 'main', archived: false },
    ];
    await listOrgRepos('ghp_test', 'my-org', 'all');
    expect(__state.lastTokenSeen).toBe('ghp_test');
    expect(__state.lastOrgSeen).toBe('my-org');
  });

  it('filters out archived repos', async () => {
    __state.repos = [
      { name: 'live', clone_url: 'u1', default_branch: 'main', archived: false },
      { name: 'dead', clone_url: 'u2', default_branch: 'main', archived: true },
    ];
    const out = await listOrgRepos('t', 'org', 'all');
    expect(out.map((r) => r.name)).toEqual(['live']);
  });

  it('propagates Octokit errors', async () => {
    __state.shouldThrow = new Error('rate limited');
    await expect(listOrgRepos('t', 'org', 'all')).rejects.toThrow('rate limited');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter mcp-server test -- test/unit/github.test.ts`
Expected: FAIL — `Cannot find module '../../src/github.js'`.

- [ ] **Step 5: Write the helper**

Create `packages/mcp-server/src/github.ts`:

```ts
import { Octokit } from '@octokit/rest';

export interface DiscoveredRepo {
  name: string;
  clone_url: string;
  default_branch: string;
  archived: boolean;
}

export async function listOrgRepos(
  token: string,
  org: string,
  visibility: 'all' | 'public' | 'private',
): Promise<DiscoveredRepo[]> {
  const octokit = new Octokit({ auth: token });
  const all = (await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: visibility === 'all' ? 'all' : visibility,
  })) as DiscoveredRepo[];
  return all.filter((r) => !r.archived);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter mcp-server test -- test/unit/github.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/github.ts \
        packages/mcp-server/test/__mocks__/@octokit/rest.ts \
        packages/mcp-server/test/unit/github.test.ts \
        packages/mcp-server/package.json \
        pnpm-lock.yaml
git commit -m "feat(mcp-server): @octokit/rest wrapper for org repo discovery"
```

---

## Task 8: Service upsert helper for GitHub-discovered repos

**Files:**
- Create: `packages/mcp-server/src/schedules/services.ts`

- [ ] **Step 1: Write the helper module**

Create `packages/mcp-server/src/schedules/services.ts`:

```ts
import type { PoolClient } from 'pg';
import type { DiscoveredRepo } from '../github.js';

export interface UpsertResult {
  service_ids: number[];
  created_count: number;
}

export async function upsertServicesFromGitHub(
  client: PoolClient,
  args: { app_id: number; schedule_id: number; repos: DiscoveredRepo[] },
): Promise<UpsertResult> {
  const service_ids: number[] = [];
  let created_count = 0;
  for (const repo of args.repos) {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM services WHERE app_id = $1 AND repo_url = $2`,
      [args.app_id, repo.clone_url],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      service_ids.push(existing.rows[0].id);
      continue;
    }
    const ins = await client.query<{ id: number }>(
      `INSERT INTO services(app_id, name, repo_url, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        args.app_id,
        repo.name,
        repo.clone_url,
        `auto-created by schedule ${args.schedule_id}`,
      ],
    );
    service_ids.push(ins.rows[0].id);
    created_count++;
  }
  return { service_ids, created_count };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp-server/src/schedules/services.ts
git commit -m "feat(mcp-server): upsert services from GitHub-discovered repos"
```

---

## Task 9: Fire path (app source + github_org source) and `run_schedule_now`

This is the core behavioral surface. The fire path:
1. (github_org only) reads token, lists repos, upserts services.
2. Opens a transaction.
3. Resolves service ids (or fails the run).
4. Checks overlap policy.
5. Renders the title.
6. Calls `createProjectInTx`.
7. Inserts a `schedule_runs` row.
8. Advances `next_run_at`.

On any failure inside the transaction, the transaction rolls back and a separate `schedule_runs(status='failed')` row is inserted with the error, and `next_run_at` is still advanced (in a separate UPDATE) so a broken schedule does not refire every tick.

**Files:**
- Create: `packages/mcp-server/src/schedules/fire.ts`
- Modify: `packages/mcp-server/src/tools/schedules.ts` (add `run_schedule_now`)
- Create: `packages/mcp-server/test/integration/schedules-fire-app.test.ts`
- Create: `packages/mcp-server/test/integration/schedules-fire-github.test.ts`

- [ ] **Step 1: Write failing tests for the app fire path**

Create `packages/mcp-server/test/integration/schedules-fire-app.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { fireSchedule } from '../../src/schedules/fire.js';
import { findScheduleByIdOrName, recentRuns } from '../../src/schedules/db.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';

const log = createLogger('error');

async function makeAppWithServices(db: TestDb): Promise<{ appId: number; svc1: number; svc2: number }> {
  await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
  const a = await db.pool.query<{ id: number }>(
    `INSERT INTO apps(name) VALUES ('fire-app') RETURNING id`,
  );
  const appId = a.rows[0].id;
  const s1 = await db.pool.query<{ id: number }>(
    `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 's1', 'https://github.com/x/s1.git') RETURNING id`,
    [appId],
  );
  const s2 = await db.pool.query<{ id: number }>(
    `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 's2', 'https://github.com/x/s2.git') RETURNING id`,
    [appId],
  );
  return { appId, svc1: s1.rows[0].id, svc2: s2.rows[0].id };
}

async function createAppSchedule(db: TestDb, appId: number, overlap = 'skip_if_running'): Promise<number> {
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO schedules
       (name, source_type, app_id, cron_expr, timezone, overlap_policy,
        title_template, description_md, definition_of_done_md, next_run_at)
     VALUES ('weekly','app',$1,'0 9 * * 1','UTC',$2,'Weekly review {{date}}',
             'review repos','reviews posted', now() - interval '1 minute')
     RETURNING id`,
    [appId, overlap],
  );
  return r.rows[0].id;
}

describe('fireSchedule — app source', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE schedule_runs, schedules RESTART IDENTITY CASCADE`);
  });

  it('fires a project with service fan-out and records a "fired" run', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId);
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;

    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('fired');
    expect(runs[0].project_id).not.toBeNull();

    const { rows: projRows } = await db.pool.query(
      `SELECT status FROM projects WHERE id = $1`,
      [runs[0].project_id],
    );
    expect(projRows[0].status).toBe('in_progress');

    const after = (await findScheduleByIdOrName(db.pool, schedId))!;
    expect(after.last_fired_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('records "skipped_overlap" when the prior project is non-terminal', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId);

    // First fire — succeeds.
    const sched1 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched1, log, now: new Date() });

    // Force next_run_at into the past so the second fire is "due".
    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched2 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched2, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs[0].status).toBe('skipped_overlap');
    expect(runs).toHaveLength(2);
  });

  it('with always_fire policy, ignores prior project state', async () => {
    const { appId } = await makeAppWithServices(db);
    const schedId = await createAppSchedule(db, appId, 'always_fire');
    const sched1 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched1, log, now: new Date() });

    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [schedId],
    );
    const sched2 = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched2, log, now: new Date() });

    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs.every((r) => r.status === 'fired')).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('records "failed" with error when the app has no services', async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('empty-app') RETURNING id`,
    );
    const schedId = await createAppSchedule(db, a.rows[0].id);
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 5);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/no services/i);
    const after = (await findScheduleByIdOrName(db.pool, schedId))!;
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('renders {{date}} and {{iso_date}} in the title', async () => {
    const { appId } = await makeAppWithServices(db);
    const r = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('templated','app',$1,'0 9 * * 1','UTC','skip_if_running',
               'Review on {{date}} ({{iso_date}})',
               'd','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    const schedId = r.rows[0].id;
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    const now = new Date('2026-05-11T12:00:00Z');
    await fireSchedule({ db: db.pool, schedule: sched, log, now });
    const runs = await recentRuns(db.pool, schedId, 1);
    const { rows: pj } = await db.pool.query<{ title: string }>(
      `SELECT title FROM projects WHERE id = $1`,
      [runs[0].project_id],
    );
    expect(pj[0].title).toContain('2026-05-11');
    expect(pj[0].title).toContain('2026-05-11T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-fire-app.test.ts`
Expected: FAIL — `Cannot find module '../../src/schedules/fire.js'`.

- [ ] **Step 3: Write the fire path**

Create `packages/mcp-server/src/schedules/fire.ts`:

```ts
import type pino from 'pino';
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';
import { nextCronTick } from '../cron.js';
import { listOrgRepos } from '../github.js';
import { createProjectInTx } from '../tools/projects.js';
import { advanceNextRun, recordRun, type ScheduleRow } from './db.js';
import { upsertServicesFromGitHub } from './services.js';

export interface FireArgs {
  db: Db;
  schedule: ScheduleRow;
  log: pino.Logger;
  now: Date;
}

function renderTitle(template: string, now: Date, tz: string): string {
  const isoDate = now.toISOString();
  const dateInTz = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return template.replaceAll('{{date}}', dateInTz).replaceAll('{{iso_date}}', isoDate);
}

async function resolveServiceIds(
  db: Db,
  schedule: ScheduleRow,
): Promise<{ kind: 'ok'; service_ids: number[] } | { kind: 'fail'; error: string }> {
  if (schedule.source_type === 'app') {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM services WHERE app_id = $1`,
      [schedule.app_id],
    );
    if (rows.length === 0) return { kind: 'fail', error: 'no services in app' };
    return { kind: 'ok', service_ids: rows.map((r) => r.id) };
  }

  // github_org path: read token from runner_config, list repos, upsert services.
  const cfg = await db.query<{ github_token: string | null; github_default_visibility: string }>(
    `SELECT github_token, github_default_visibility FROM runner_config WHERE id = 1`,
  );
  const token = cfg.rows[0]?.github_token;
  const visibility = (cfg.rows[0]?.github_default_visibility ?? 'all') as 'all' | 'public' | 'private';
  if (!token) return { kind: 'fail', error: 'github_token not configured' };

  let repos;
  try {
    repos = await listOrgRepos(token, schedule.github_org!, visibility);
  } catch (err) {
    return { kind: 'fail', error: `github listOrgRepos failed: ${(err as Error).message}` };
  }
  if (repos.length === 0)
    return { kind: 'fail', error: `no repos discovered for org ${schedule.github_org}` };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await upsertServicesFromGitHub(client, {
      app_id: schedule.app_id,
      schedule_id: schedule.id,
      repos,
    });
    await client.query('COMMIT');
    return { kind: 'ok', service_ids: out.service_ids };
  } catch (err) {
    await client.query('ROLLBACK');
    return { kind: 'fail', error: `service upsert failed: ${(err as Error).message}` };
  } finally {
    client.release();
  }
}

async function hasNonTerminalLastProject(client: PoolClient, schedule_id: number): Promise<boolean> {
  const { rows } = await client.query<{ status: string | null }>(
    `SELECT p.status
       FROM schedule_runs sr
       LEFT JOIN projects p ON p.id = sr.project_id
       WHERE sr.schedule_id = $1
       ORDER BY sr.fired_at DESC LIMIT 1`,
    [schedule_id],
  );
  const status = rows[0]?.status;
  return status === 'pending' || status === 'scoping' || status === 'in_progress' || status === 'blocked';
}

export type FireOutcome =
  | { status: 'fired'; project_id: number; duration_ms: number }
  | { status: 'skipped_overlap' }
  | { status: 'failed'; error: string };

export async function fireSchedule(args: FireArgs): Promise<FireOutcome> {
  const { db, schedule, log, now } = args;
  const start = Date.now();
  const advanceDate = nextCronTick(schedule.cron_expr, schedule.timezone, now);

  const resolved = await resolveServiceIds(db, schedule);
  if (resolved.kind === 'fail') {
    await recordFailure(db, schedule.id, advanceDate, resolved.error, Date.now() - start);
    log.warn({ event: 'schedule_fire', schedule_id: schedule.id, status: 'failed', error: resolved.error });
    return { status: 'failed', error: resolved.error };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (schedule.overlap_policy === 'skip_if_running') {
      const overlap = await hasNonTerminalLastProject(client, schedule.id);
      if (overlap) {
        await recordRun(client, { schedule_id: schedule.id, status: 'skipped_overlap' });
        await advanceNextRun(client, schedule.id, advanceDate, false);
        await client.query('COMMIT');
        log.info({ event: 'schedule_fire', schedule_id: schedule.id, status: 'skipped_overlap' });
        return { status: 'skipped_overlap' };
      }
    }

    const title = renderTitle(schedule.title_template, now, schedule.timezone);
    const result = await createProjectInTx(client, {
      app_id: schedule.app_id,
      app_name: '',
      title,
      description_md: schedule.description_md,
      definition_of_done_md: schedule.definition_of_done_md,
      service_ids: resolved.service_ids,
    });

    const duration_ms = Date.now() - start;
    await recordRun(client, {
      schedule_id: schedule.id,
      status: 'fired',
      project_id: result.project.id as number,
      duration_ms,
    });
    await advanceNextRun(client, schedule.id, advanceDate, true);
    await client.query('COMMIT');
    log.info({
      event: 'schedule_fire',
      schedule_id: schedule.id,
      source_type: schedule.source_type,
      project_id: result.project.id,
      status: 'fired',
      durationMs: duration_ms,
    });
    return { status: 'fired', project_id: result.project.id as number, duration_ms };
  } catch (err) {
    await client.query('ROLLBACK');
    const msg = (err as Error).message;
    await recordFailure(db, schedule.id, advanceDate, msg, Date.now() - start);
    log.error({ event: 'schedule_fire', schedule_id: schedule.id, status: 'failed', error: msg });
    return { status: 'failed', error: msg };
  } finally {
    client.release();
  }
}

async function recordFailure(
  db: Db,
  schedule_id: number,
  next_run_at: Date,
  error: string,
  duration_ms: number,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await recordRun(client, { schedule_id, status: 'failed', error, duration_ms });
    await advanceNextRun(client, schedule_id, next_run_at, false);
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the app-source fire tests**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-fire-app.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Write failing tests for github_org fire path**

Create `packages/mcp-server/test/integration/schedules-fire-github.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/rest');

import { runMigrations } from '../../src/migrate.js';
import { fireSchedule } from '../../src/schedules/fire.js';
import { findScheduleByIdOrName, recentRuns } from '../../src/schedules/db.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';
import { __resetMock, __state } from '../__mocks__/@octokit/rest.js';

const log = createLogger('error');

describe('fireSchedule — github_org source', () => {
  let db: TestDb;
  let appId: number;
  let schedId: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    __resetMock();
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    await db.pool.query(`UPDATE runner_config SET github_token = NULL WHERE id = 1`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('gh-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    const r = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, github_org, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('gh-weekly','github_org',$1,'my-org','0 9 * * 1','UTC','skip_if_running',
               'GH review {{date}}','d','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    schedId = r.rows[0].id;
  });

  it('fails with "github_token not configured" when token is null', async () => {
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/github_token/i);
  });

  it('discovers repos, auto-creates services, and fires a project', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    __state.repos = [
      { name: 'r1', clone_url: 'https://github.com/my-org/r1.git', default_branch: 'main', archived: false },
      { name: 'r2', clone_url: 'https://github.com/my-org/r2.git', default_branch: 'main', archived: false },
    ];
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('fired');
    const { rowCount } = await db.pool.query(`SELECT 1 FROM services WHERE app_id = $1`, [appId]);
    expect(rowCount).toBe(2);
  });

  it('reuses existing service when repo_url matches', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    await db.pool.query(
      `INSERT INTO services(app_id, name, repo_url) VALUES ($1, 'existing', 'https://github.com/my-org/r1.git')`,
      [appId],
    );
    __state.repos = [
      { name: 'r1', clone_url: 'https://github.com/my-org/r1.git', default_branch: 'main', archived: false },
    ];
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const { rowCount } = await db.pool.query(`SELECT 1 FROM services WHERE app_id = $1`, [appId]);
    expect(rowCount).toBe(1);
  });

  it('records failure on Octokit error', async () => {
    await db.pool.query(`UPDATE runner_config SET github_token = 'ghp_x' WHERE id = 1`);
    __state.shouldThrow = new Error('rate limited');
    const sched = (await findScheduleByIdOrName(db.pool, schedId))!;
    await fireSchedule({ db: db.pool, schedule: sched, log, now: new Date() });
    const runs = await recentRuns(db.pool, schedId, 1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/rate limited|github listOrgRepos/i);
  });
});
```

- [ ] **Step 6: Run the github_org tests**

Run: `pnpm --filter mcp-server test -- test/integration/schedules-fire-github.test.ts`
Expected: PASS (4 cases). If the Octokit mock doesn't intercept (e.g., real network attempted), revisit the `vi.mock('@octokit/rest')` placement — it must be at the top of the file before the import.

- [ ] **Step 7: Add `run_schedule_now` MCP tool**

Edit `packages/mcp-server/src/tools/schedules.ts`. Add this registration inside `registerSchedules`, after `disable_schedule`, **and** add the import:

```ts
import { fireSchedule } from '../schedules/fire.js';
import { createLogger } from '../logger.js';
```

```ts
  server.registerTool(
    'run_schedule_now',
    {
      description:
        'Fire a schedule out-of-band immediately. Honors overlap_policy (a skip_if_running schedule with a non-terminal prior project will record a skipped_overlap run). Records a schedule_runs row.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const log = createLogger('info');
      const outcome = await fireSchedule({ db, schedule: sched, log, now: new Date() });
      return ok(outcome);
    },
  );
```

- [ ] **Step 8: Append a test for `run_schedule_now` to the CRUD suite**

In `packages/mcp-server/test/integration/schedules-crud.test.ts`, add at the bottom of the describe block:

```ts
  it('run_schedule_now fires immediately, ignoring next_run_at', async () => {
    await db.pool.query(`INSERT INTO services(app_id, name, repo_url) VALUES (1, 'svc', 'u')`);
    // Advance the schedule's next_run_at into the future to prove run_schedule_now ignores it.
    const c = (await client.call('create_schedule', valid)) as { id: number };
    await db.pool.query(
      `UPDATE schedules SET next_run_at = now() + interval '1 year' WHERE id = $1`,
      [c.id],
    );
    const out = (await client.call('run_schedule_now', { id: c.id })) as { status: string };
    expect(out.status).toBe('fired');
  });
```

- [ ] **Step 9: Run all schedule tests**

Run:
```
pnpm --filter mcp-server test -- \
  test/integration/schedules-crud.test.ts \
  test/integration/schedules-fire-app.test.ts \
  test/integration/schedules-fire-github.test.ts
```
Expected: PASS (all cases across all three files).

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-server/src/schedules/fire.ts \
        packages/mcp-server/src/tools/schedules.ts \
        packages/mcp-server/test/integration/schedules-fire-app.test.ts \
        packages/mcp-server/test/integration/schedules-fire-github.test.ts \
        packages/mcp-server/test/integration/schedules-crud.test.ts
git commit -m "feat(mcp-server): scheduler fire path + run_schedule_now (app + github_org sources)"
```

---

## Task 10: Scheduler tick loop, wired into mcp-server startup

The tick selects all due+enabled schedules, fires each serially, and is started by `index.ts` after migrations succeed. Default interval is 10000 ms; overridable via `SCHEDULER_TICK_MS`.

**Files:**
- Create: `packages/mcp-server/src/schedules/scheduler.ts`
- Modify: `packages/mcp-server/src/config.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/test/integration/scheduler-tick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/test/integration/scheduler-tick.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { tick } from '../../src/schedules/scheduler.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';
import { createLogger } from '../../src/logger.js';
import { recentRuns } from '../../src/schedules/db.js';

const log = createLogger('error');

describe('scheduler tick', () => {
  let db: TestDb;
  let appId: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('tick-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    await db.pool.query(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc')`,
      [appId],
    );
  });

  it('fires due schedules and skips not-due ones', async () => {
    // Due (next_run_at in past).
    const due = await db.pool.query<{ id: number }>(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('due','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() - interval '1 minute')
       RETURNING id`,
      [appId],
    );
    // Not due.
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at)
       VALUES ('not-due','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() + interval '1 hour')`,
      [appId],
    );

    const summary = await tick(db.pool, log);
    expect(summary.due).toBe(1);
    expect(summary.fired).toBe(1);

    const runs = await recentRuns(db.pool, due.rows[0].id, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('fired');
  });

  it('ignores disabled schedules even if next_run_at is past', async () => {
    await db.pool.query(
      `INSERT INTO schedules
         (name, source_type, app_id, cron_expr, timezone, overlap_policy,
          title_template, description_md, definition_of_done_md, next_run_at, enabled)
       VALUES ('off','app',$1,'0 * * * *','UTC','skip_if_running',
               't','d','dod', now() - interval '1 minute', FALSE)`,
      [appId],
    );
    const summary = await tick(db.pool, log);
    expect(summary.due).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test -- test/integration/scheduler-tick.test.ts`
Expected: FAIL — `Cannot find module '../../src/schedules/scheduler.js'`.

- [ ] **Step 3: Implement the scheduler**

Create `packages/mcp-server/src/schedules/scheduler.ts`:

```ts
import type pino from 'pino';
import type { Db } from '../db.js';
import { fireSchedule, type FireOutcome } from './fire.js';
import type { ScheduleRow } from './db.js';

export interface TickSummary {
  due: number;
  fired: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export async function tick(db: Db, log: pino.Logger): Promise<TickSummary> {
  const start = Date.now();
  const { rows } = await db.query<ScheduleRow>(
    `SELECT * FROM schedules
      WHERE enabled = TRUE AND next_run_at <= now()
      ORDER BY next_run_at ASC`,
  );
  let fired = 0;
  let skipped = 0;
  let failed = 0;
  for (const sched of rows) {
    const outcome: FireOutcome = await fireSchedule({ db, schedule: sched, log, now: new Date() });
    if (outcome.status === 'fired') fired++;
    else if (outcome.status === 'skipped_overlap') skipped++;
    else failed++;
  }
  const summary: TickSummary = {
    due: rows.length,
    fired,
    skipped,
    failed,
    durationMs: Date.now() - start,
  };
  log.info({ event: 'schedule_tick', ...summary });
  return summary;
}

export interface SchedulerHandle {
  stop: () => Promise<void>;
}

export function startScheduler(db: Db, log: pino.Logger, intervalMs: number): SchedulerHandle {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopping = false;

  const runOnce = async () => {
    if (running || stopping) return;
    running = true;
    try {
      await tick(db, log);
    } catch (err) {
      log.error({ event: 'schedule_tick_error', err: (err as Error).message });
    } finally {
      running = false;
    }
  };

  timer = setInterval(runOnce, intervalMs);
  // Run once immediately on startup.
  void runOnce();

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      // Wait for an in-flight tick to drain.
      while (running) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
```

- [ ] **Step 4: Add the config field**

Edit `packages/mcp-server/src/config.ts`:

```ts
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  SAPLING_PORT: z.coerce.number().int().positive().default(3333),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PAYLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MCP_TOKEN: z.string().optional(),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(10000),
});
```

- [ ] **Step 5: Wire the scheduler into the server bootstrap**

Edit `packages/mcp-server/src/index.ts`:

```ts
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './server.js';
import { startScheduler } from './schedules/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const pool = createPool(config.DATABASE_URL);
  log.info('running migrations');
  await runMigrations(pool);

  const { app } = createApp({ db: pool, token: config.MCP_TOKEN, log });
  const scheduler = startScheduler(pool, log, config.SCHEDULER_TICK_MS);

  const server = app.listen(config.SAPLING_PORT, () => {
    log.info({ port: config.SAPLING_PORT }, 'sapling mcp-server listening');
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await scheduler.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Run the scheduler tick test**

Run: `pnpm --filter mcp-server test -- test/integration/scheduler-tick.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 7: Run the full suite as a regression check**

Run: `make test`
Expected: All existing + new tests pass. If anything red, diff and fix before moving on.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/schedules/scheduler.ts \
        packages/mcp-server/src/config.ts \
        packages/mcp-server/src/index.ts \
        packages/mcp-server/test/integration/scheduler-tick.test.ts
git commit -m "feat(mcp-server): in-process scheduler tick wired into bootstrap"
```

---

## Task 11: `/sapling:schedule` plugin skill

**Files:**
- Create: `packages/claude-plugin/skills/schedule/SKILL.md`

- [ ] **Step 1: Create the skill**

Create `packages/claude-plugin/skills/schedule/SKILL.md`:

```markdown
---
name: schedule
description: Create, inspect, and manage recurring Sapling projects on a cron schedule. Triggers on /sapling:schedule.
---

# /sapling:schedule

Schedule a recurring project. Each schedule fires `create_project` on a cron cadence — either against the services in a Sapling app, or against repos discovered live from a GitHub org at fire time.

## Forms

```
/sapling:schedule                          — list all schedules grouped by app
/sapling:schedule show <id_or_name>        — full detail + last 5 runs + next 3 fire times
/sapling:schedule create                   — interactive create flow
/sapling:schedule edit <id>                — interactive patch
/sapling:schedule enable <id>              — flip enabled = true; recomputes next_run_at
/sapling:schedule disable <id>             — flip enabled = false; in-flight projects untouched
/sapling:schedule run <id>                 — fire immediately (honors overlap_policy)
/sapling:schedule delete <id>              — confirm, then hard delete (cascades schedule_runs)
```

## GitHub-bound text

Same rule as `/sapling:project`: never use `#N` to reference a Sapling schedule, run, project, or work item in PR titles, PR bodies, PR comments, or commit messages. Use `Sapling schedule N`, `Sapling project N`, etc. `#N` is fine in chat output and Sapling artifacts.

## Steps — list (no args)

1. Call `mcp__sapling__list_schedules({})`.
2. Group rows by app (via `mcp__sapling__get_app({ id: schedule.app_id })` cache).
3. Render one row per schedule:

   ```
   ## <app-name>
   #<id>  <name>  enabled=<true|false>  source=<source_type>  cron="<cron_expr>" tz=<timezone>
        next: <next_run_at>  last: <last_fired_at?>
   ```

## Steps — `show <id_or_name>`

1. Call `mcp__sapling__get_schedule({ id_or_name })`. The response is `{ schedule, last_run, last_5_runs, next_3_fires }`.
2. Render the schedule body (description_md and DoD), then a runs table:

   ```
   ## Schedule #<id> "<name>" — <source_type>
   cron="<cron_expr>" tz=<timezone> overlap=<overlap_policy> enabled=<bool>
   next_run_at: <next_run_at>   last_fired_at: <last_fired_at?>

   ### Next 3 fires
   - <next_3_fires[0]>
   - <next_3_fires[1]>
   - <next_3_fires[2]>

   ### Last 5 runs
   #<run_id>  <fired_at>  <status>  project=<project_id?>  duration=<duration_ms?>ms
   <error if status=failed>
   ```

## Steps — `create`

1. Ask the user for `name` (must be globally unique, kebab-case recommended).
2. Ask for `source_type`: `app` or `github_org`.
3. Ask for the `app_name` (or list apps via `mcp__sapling__list_apps()` if the user is unsure).
4. If `source_type=github_org`: ask for the `github_org` string. Then call `mcp__sapling__get_runner_config()` and check `github_token`. If it is `null`, warn the user and offer to call `mcp__sapling__update_runner_config({ github_token: '<value>' })` before proceeding. Do not let the schedule be created until either the token is set OR the user explicitly confirms they want to create the schedule despite knowing it will fail at fire time.
5. Ask for `cron_expr`. Accept shorthand and translate before calling:
   - `@hourly` → `0 * * * *`
   - `@daily` → `0 0 * * *`
   - `@weekly` → `0 0 * * 0`
   - `@monthly` → `0 0 1 * *`
   - `@weekdays` → `0 9 * * 1-5` (treat as "9am weekdays")
   Otherwise pass the user's 5-field expression through verbatim.
6. Ask for `timezone` (IANA, e.g. `Europe/Stockholm`). Default `UTC`.
7. Ask for `overlap_policy`: `skip_if_running` (default) or `always_fire`.
8. Ask for `title_template`. Show a rendered example using `{{date}}` substituted with today's date in the chosen timezone before submission, so the user catches a typo.
9. Ask for `description_md` and `definition_of_done_md`. Apply the same DoD bar from `/sapling:project create`: push for verifiable success criteria.
10. Before submitting, render the next 3 fire times by calling `mcp__sapling__get_schedule` on a hypothetical schedule — or, simpler, **call `create_schedule` first, then immediately call `get_schedule` to confirm next_3_fires looks right**. If the next fire time looks wrong, call `mcp__sapling__delete_schedule` and start over.
11. Call `mcp__sapling__create_schedule({ ... })`. On success, print:

    ```
    Created Sapling schedule <id> "<name>" in app <app>. First fire: <next_run_at>.
    ```

## Steps — `edit <id>`

1. Call `mcp__sapling__get_schedule({ id_or_name: id })`.
2. List the patchable fields (`cron_expr`, `timezone`, `overlap_policy`, `title_template`, `description_md`, `definition_of_done_md`, `enabled`) and let the user pick. **Non-patchable fields** (`name`, `source_type`, `app_id`, `github_org`) are not editable — to change them, delete and recreate.
3. Call `mcp__sapling__update_schedule({ id, ... })`.
4. If `cron_expr` or `timezone` was changed, fetch the schedule again and show the new `next_run_at` + next 3 fires so the user can sanity-check.

## Steps — `enable / disable / delete / run`

- `enable`: `mcp__sapling__enable_schedule({ id })`. Print the new `next_run_at`.
- `disable`: `mcp__sapling__disable_schedule({ id })`. Note that in-flight spawned projects are untouched — list them by calling `mcp__sapling__list_projects({ app_name })` filtered on the schedule's app if you want to surface them.
- `run`: `mcp__sapling__run_schedule_now({ id })`. Print the outcome (`fired` + `project_id`, `skipped_overlap`, or `failed` + `error`). On `fired`, append: "Run /sapling:project show <project_id> for detail."
- `delete`: confirm with the user that this cascades `schedule_runs` (not projects). Call `mcp__sapling__delete_schedule({ id })`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/claude-plugin/skills/schedule/SKILL.md
git commit -m "feat(plugin): /sapling:schedule skill (multi-action)"
```

---

## Task 12: Extend `/sapling:status` to include the schedule summary

**Files:**
- Modify: `packages/claude-plugin/skills/status/SKILL.md`

- [ ] **Step 1: Patch the skill**

In `packages/claude-plugin/skills/status/SKILL.md`, after step 3 (the `list_projects` parallel call) and before step 4 (the per-app rendering), add:

```markdown
3b. **In parallel, call** `mcp__sapling__list_schedules({})`. If the result is non-empty, also call `mcp__sapling__list_work({ status: 'pending' })`-style query is unnecessary here — for each schedule the relevant signal is its own `next_run_at` (already in the row) and the most recent failed run. To get the latter without N round-trips, run one targeted SQL-style read: call `mcp__sapling__get_schedule({ id_or_name: id })` only for schedules whose `last_fired_at` is non-null AND older than `next_run_at - 5 minutes` (a heuristic for "we just failed"). Skip entirely if `list_schedules` returned `[]`.
```

Then, before the cross-app totals row (step 5), insert a new step **4b**:

```markdown
4b. **Schedules summary** (only if `list_schedules` returned ≥1 row). Output a single section above the totals row:

    ```
    ## Schedules
    SCHEDULES <total> ENABLED <e> DISABLED <d>
    next fire: <ISO> — "<name>" (in <Nm|Nh|Nd>)
    last failure: <ISO> — "<name>" (<error>)
    ```

    "next fire" is the schedule with the smallest `next_run_at` among enabled rows. "last failure" is the most recent failed run across all schedules (only printed if at least one exists). If neither line has data to show, omit that line. If there are zero schedules, omit the entire Schedules section (matches how awaiting_input is omitted when zero).
```

- [ ] **Step 2: Commit**

```bash
git add packages/claude-plugin/skills/status/SKILL.md
git commit -m "feat(plugin): /sapling:status surfaces schedule summary"
```

---

## Task 13: Update SPEC.md, README.md, and bump plugin version

**Files:**
- Modify: `SPEC.md`
- Modify: `README.md`
- Modify: `packages/claude-plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Bump the plugin version**

In `packages/claude-plugin/.claude-plugin/plugin.json`, bump `"version"` from the current value (`0.9.0` at the time of writing) to the next minor: `0.10.0`. Confirm the current value first with `grep version packages/claude-plugin/.claude-plugin/plugin.json` — if it has already moved past 0.9.x, bump from that.

- [ ] **Step 2: Update `SPEC.md`**

Make these edits in a single pass:

**§ 2 Non-goals** — append to the "Non-goals (v1)" list:

```markdown
- Catch-up runs for missed scheduler ticks. A disabled or backlogged schedule fires once on resume; missed ticks are silently dropped.
- GitHub webhook listeners. Schedule discovery is pull-only at fire time.
- GitHub App auth. Personal access token only.
- Multi-org schedules; per-repo topic/language filters. One schedule = one source.
- Notifications on schedule failure beyond `/sapling:status`. No ntfy push for scheduler failures.
```

**§ 3 Architecture** — add to the "Key decisions" bullet list:

```markdown
- **In-process scheduler.** A `setInterval` inside the same mcp-server process polls due `schedules` rows every `SCHEDULER_TICK_MS` (default 10000) and invokes `createProjectInTx` for each, recording outcomes in `schedule_runs`. No new container, no new daemon. GitHub-org schedules discover repos live via `@octokit/rest` at fire time.
```

**§ 5 Data model — Tables** — append to the migrations table:

```markdown
| `011_schedules.sql`             | Creates `schedules`, `schedule_runs`, enums `schedule_source` / `schedule_overlap` / `schedule_run_status`; adds `runner_config.github_token` (nullable) and `runner_config.github_default_visibility` (default `'all'`). |
```

Then add two new rows to the "Tables" bullet list (after `runner_config`):

```markdown
- **`schedules`** — recurring intent. `(name)` globally unique. Carries `source_type` (`'app' | 'github_org'`), `app_id` (NOT NULL, `ON DELETE CASCADE`), optional `github_org`, `cron_expr`, `timezone`, `overlap_policy`, `title_template` (supports `{{date}}` and `{{iso_date}}`), `description_md`, `definition_of_done_md`, `enabled`, `last_fired_at`, `next_run_at`. CHECK enforces `(source_type='app' AND github_org IS NULL) OR (source_type='github_org' AND github_org IS NOT NULL)`.
- **`schedule_runs`** — audit row per fire attempt. `schedule_id → schedules.id ON DELETE CASCADE`, `project_id → projects.id ON DELETE SET NULL`. Status is one of `'fired' | 'skipped_overlap' | 'failed'`.
```

**§ 7 MCP tool surface** — change the header line from "Total: 49 tools" to "Total: 57 tools" and add a new subsection:

```markdown
### Schedules (`tools/schedules.ts`) — 8 tools

| Tool | Purpose |
| ---- | ------- |
| `create_schedule({ name, source_type, app_name, github_org?, cron_expr, timezone?, overlap_policy?, title_template, description_md, definition_of_done_md })` | Validates cron + IANA timezone. For `github_org`, requires `github_org`. Computes initial `next_run_at`. |
| `get_schedule(id_or_name)` | Returns `{ schedule, last_run, last_5_runs, next_3_fires }`. |
| `list_schedules({ app_name?, source_type?, enabled? })` | Filtered list. |
| `update_schedule(id, { cron_expr?, timezone?, overlap_policy?, title_template?, description_md?, definition_of_done_md?, enabled? })` | Patch. Changing `cron_expr` or `timezone` recomputes `next_run_at`. `source_type`, `app_id`, `github_org`, `name` are not patchable — recreate. |
| `delete_schedule(id)` | Hard delete. Cascades `schedule_runs`; spawned projects untouched. |
| `enable_schedule(id)` / `disable_schedule(id)` | Flip `enabled`. Enable recomputes `next_run_at` from now. |
| `run_schedule_now(id)` | Out-of-band fire. Honors `overlap_policy`. |
```

**§ 13 Configuration surface** — add `github_token` (nullable) and `github_default_visibility` (default `'all'`) to the `runner_config` keys table. Also document the new env var `SCHEDULER_TICK_MS` (default `10000`).

- [ ] **Step 3: Update `README.md`**

In `README.md`, find the section that lists slash commands (around the quickstart) and add:

```markdown
- `/sapling:schedule [<action> [args…]]` — manage recurring projects (create / list / show / edit / enable / disable / run / delete)
```

Then add a new subsection under the "Common commands" block (or after "Optional auth"):

```markdown
## Recurring projects

Sapling can fire `create_project` on a cron schedule. Each schedule targets either:

- a Sapling **app** — resolved to its current `services` at fire time, or
- a **GitHub org** — repos discovered live via the GitHub API at fire time and mapped to (or auto-created as) services under a designated app.

```text
/sapling:schedule create
# walks you through name, source, cron, timezone, title template, DoD
```

Configure the GitHub token first if you plan to use `github_org` sources:

```text
update_runner_config({ github_token: "ghp_…" })
```

Inspect: `/sapling:schedule` (list) or `/sapling:schedule show <id>` (detail + next 3 fires + last 5 runs).

The scheduler ticks every `SCHEDULER_TICK_MS` ms (default 10000) inside `mcp-server`; no extra process required.
```

- [ ] **Step 4: Verify the doc changes**

Run: `git diff SPEC.md README.md packages/claude-plugin/.claude-plugin/plugin.json`
Expected: every section listed above is present; the version bump is exactly one minor jump.

Also run the test suite once more to confirm nothing in the implementation drifted while you were editing markdown:

Run: `make test`
Expected: PASS for all suites.

- [ ] **Step 5: Commit**

```bash
git add SPEC.md README.md packages/claude-plugin/.claude-plugin/plugin.json
git commit -m "docs(spec,readme,plugin): recurring projects — SPEC §2/§3/§5/§7/§13, README, plugin 0.10.0"
```

---

## Task 14: Final regression + manual smoke

- [ ] **Step 1: Full test run**

Run: `make test`
Expected: PASS.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter mcp-server typecheck`
Expected: clean (no errors).

- [ ] **Step 3: Bring up the stack and exercise the new tools**

```bash
make build
make up
sleep 3
curl -s http://127.0.0.1:3333/health
```

Then, in a session with the Sapling MCP wired up:

```text
register_app({ name: "demo" })
register_service({ app_name: "demo", name: "svc-a" })
register_service({ app_name: "demo", name: "svc-b" })
create_schedule({
  name: "demo-hourly",
  source_type: "app",
  app_name: "demo",
  cron_expr: "0 * * * *",
  timezone: "UTC",
  title_template: "Demo review {{date}}",
  description_md: "review",
  definition_of_done_md: "reviews posted"
})
run_schedule_now({ id: 1 })
get_schedule({ id_or_name: 1 })
```

Expected:
- `create_schedule` returns a row with `next_run_at` ~ next top of hour UTC.
- `run_schedule_now` returns `{ status: "fired", project_id: <N>, … }`.
- `get_schedule` returns the schedule plus 1 run + 3 next-fire times.

Verify in the DB:

```bash
make psql
```
```sql
SELECT id, name, status FROM projects;
SELECT * FROM schedule_runs;
\q
```

Expected: one project in `in_progress`, one `schedule_runs` row in `fired`.

- [ ] **Step 4: Bring it down**

```bash
make down
```

- [ ] **Step 5: Final commit (only if anything tweaked during smoke)**

If the smoke surfaced a fix, commit it as a separate `fix(...)` commit. If nothing changed, no commit needed.

---

## Self-review checklist

Run through this once before declaring the plan ready:

1. **Spec coverage:** Every section in the spec has a task. §1–2 (problem + goals) covered by the overall plan framing. §3 (architecture) → Task 10. §4 (data model) → Task 1. §5 (lifecycle) → Tasks 9–10. §6 (tool surface) → Tasks 3, 6, 9. §7 (GitHub source) → Tasks 7–9. §8 (plugin) → Tasks 11–12. §9 (error handling) → covered across Tasks 3, 6, 9 (`AppError` codes use `invalid_input`, not `bad_request`). §10 (observability) → Tasks 9–10 (structured `pino` log lines). §11 (testing) → tests embedded in each task. §12 (SPEC updates) → Task 13. §13 (out of scope) → unchanged.
2. **Placeholder scan:** No "TBD", "TODO", or "implement later". All code blocks are complete to the level a fresh engineer can copy them. The only judgment call is Task 4 step 3's note about copying the existing `create_project` body verbatim, which is explicit.
3. **Type consistency:** `createProjectInTx` signature defined in Task 4 and consumed in Task 9. `ScheduleRow` defined in Task 5 and consumed in Tasks 6, 9, 10. `FireOutcome` defined in Task 9 and consumed in `run_schedule_now` (Task 9 step 7) and `tick` (Task 10). All identifiers match across tasks.
4. **Error-code mapping:** Spec says "bad_request"; codebase uses `invalid_input`. Captured in the "Important codebase notes" at the top.

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-recurring-projects.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
