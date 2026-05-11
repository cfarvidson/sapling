# block_project cascade + awaiting_input visibility — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `block_project` so it actually halts further work on a project (cascading to `pending` and `awaiting_input` children), fix `unblock_project` so it replays _all_ completions during the blocked window (not just the last), surface `awaiting_input` ages in `/sapling:status` and the runner heartbeat, and add a self-hosted ntfy service plus a runner-side notifier so stuck `awaiting_input` items can reach your phone.

**Architecture:**

- Server-side: extend `block_project` and `unblock_project` in `packages/mcp-server/src/tools/projects.ts` with cascade UPDATEs. Add migration `010_runner_ntfy_config.sql` adding three columns to `runner_config` (`ntfy_url`, `awaiting_input_nag_age_ms`, `awaiting_input_nag_repeat_ms`). Extend `update_runner_config` to accept them.
- Runner-side: new `packages/runner/src/notifier.ts` module that POSTs to ntfy when `awaiting_input` items age past the threshold (with in-memory `Map<id, Date>` throttle). Wired into `tick()` after spawning. Logger surfaces `⚠ awaiting_input: N (oldest Xh)` whenever count > 0.
- Skill: `/sapling:status` shows oldest `awaiting_input` age beside the count.
- Infra: third docker-compose service `ntfy`, loopback-bound by default. README documents Tailscale (recommended), LAN, and Cloudflare Tunnel exposure paths.

**Tech Stack:** TypeScript (Node 22, ESM), Postgres 16, vitest, testcontainers, `@modelcontextprotocol/sdk`, the `binwiederhier/ntfy` Docker image.

**Spec reference:** `docs/superpowers/specs/2026-05-10-block-project-cascade-and-awaiting-input-design.md`.

---

## Pre-flight: existing context an implementer must know

- Migrations are forward-only SQL files in `packages/mcp-server/src/schema/`, applied lexicographically by `runMigrations` in `packages/mcp-server/src/migrate.ts`. The next file is `010_*.sql` (009 is taken: `009_runner_max_concurrent_default.sql`).
- Project tools live in `packages/mcp-server/src/tools/projects.ts`. The current `block_project` is a single UPDATE (lines 425–452). The current `unblock_project` (lines 455–521) replays only the most recent completion. `advanceProjectAfterWorkCompletion` (lines 591–666) early-returns when project status is not `scoping`/`in_progress` and contains the per-plan-review (lines 615–639) and DoD-verifier (lines 642–665) auto-enqueue branches; both are idempotent.
- `cancel_project` (lines 372–422) is the reference cascade: it wraps an UPDATE on children inside a transaction. Mirror its shape.
- The `runner_config` row is a singleton (`PRIMARY KEY DEFAULT 1 CHECK (id = 1)`). Its tool surface is in `packages/mcp-server/src/tools/runner_config.ts`.
- The runner is in `packages/runner/`. `tick()` in `src/loop.ts` is a pure function with injected deps; tests stub `spawn`. `createLogger()` in `src/logger.ts` filters idle ticks and emits a heartbeat every `HEARTBEAT_EVERY` (20) consecutive idle ticks. `mcp_client.ts` wraps the MCP SDK client.
- `list_work` (`packages/mcp-server/src/tools/work.ts:176`) accepts `status: 'awaiting_input'` and returns `SELECT w.*` so each row carries `updated_at`.
- `./data/` is already in `.gitignore`, so `./data/ntfy/` is covered automatically — **no .gitignore change is needed** despite the spec mentioning it.
- Existing plugin version is `0.8.0` in `packages/claude-plugin/.claude-plugin/plugin.json`. A skill output change requires a patch bump to `0.8.1` per `CLAUDE.md`.
- Test pattern (mcp-server integration): each `describe` block sets up a `testcontainers` Postgres via `startTestDb`, runs migrations, registers tools, connects an in-memory MCP client. `beforeEach` truncates `apps RESTART IDENTITY CASCADE`. Use `client.call(name, args)` for happy-path JSON, `client.callRaw(name, args)` for error inspection.
- Test pattern (runner): `loop.test.ts` uses `startInProcessMcp` and `makeStubSpawn` helpers. `logger.test.ts` builds a writable that captures stdout/file lines.
- Run mcp-server tests: `pnpm --filter @sapling/mcp-server test`. Run runner tests: `pnpm --filter @sapling/runner test`. Or `make test` for both. Docker must be running for testcontainers.
- Always run `npx prettier --write .` and `pnpm lint -- --fix` (or repo equivalents) on changed files before each commit per the user's global instructions.
- Per `CLAUDE.md`: any change to MCP tool surface or runner config keys requires a `SPEC.md` update **in the same commit / PR**.

---

## Task 1: Add migration 010 — runner_config ntfy columns

**Files:**

- Create: `packages/mcp-server/src/schema/010_runner_ntfy_config.sql`
- Modify: `packages/mcp-server/test/integration/migrate.test.ts`

- [ ] **Step 1: Write failing test for migration applied**

Open `packages/mcp-server/test/integration/migrate.test.ts` and find the assertion that lists migration filenames. Add `'010_runner_ntfy_config.sql'` to the expected list (preserve order). If the test asserts the count, increment it.

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @sapling/mcp-server test -- migrate.test
```

Expected: FAIL — assertion missing `010_runner_ntfy_config.sql`.

- [ ] **Step 3: Create the migration file**

Create `packages/mcp-server/src/schema/010_runner_ntfy_config.sql`:

```sql
ALTER TABLE runner_config
  ADD COLUMN IF NOT EXISTS ntfy_url                     TEXT,
  ADD COLUMN IF NOT EXISTS awaiting_input_nag_age_ms    INT  NOT NULL DEFAULT 3600000,
  ADD COLUMN IF NOT EXISTS awaiting_input_nag_repeat_ms INT  NOT NULL DEFAULT 21600000;
```

- [ ] **Step 4: Run test to verify it passes**

```
pnpm --filter @sapling/mcp-server test -- migrate.test
```

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/mcp-server/test/integration/migrate.test.ts
git add packages/mcp-server/src/schema/010_runner_ntfy_config.sql \
        packages/mcp-server/test/integration/migrate.test.ts
git commit -m "feat(mcp-server): migration 010 — runner_config ntfy columns"
```

---

## Task 2: block_project cascade — failing tests

**Files:**

- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts` (extend the existing `describe('block_project / unblock_project', ...)` block at line 517)

- [ ] **Step 1: Add cascade tests**

Inside the existing `describe('block_project / unblock_project', ...)` block, add the following tests after the existing `it('blocks a scoping project ...')` test:

```ts
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

  const after = await db.pool.query<{ id: number; status: string; failure_reason: string | null }>(
    `SELECT id, status, failure_reason FROM work_items WHERE id IN ($1,$2,$3) ORDER BY id`,
    [pendingChild, claimedChild, completedChild],
  );
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @sapling/mcp-server test -- projects-tools
```

Expected: the three new tests FAIL — current `block_project` does not cascade and does not return `cascade_blocked_count`.

- [ ] **Step 3: Commit the failing tests**

```bash
npx prettier --write packages/mcp-server/test/integration/projects-tools.test.ts
git add packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "test(mcp-server): block_project cascade — failing tests"
```

---

## Task 3: block_project cascade — implementation

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts` (the `block_project` tool definition, currently lines 424–452)

- [ ] **Step 1: Replace the block_project handler**

Replace the entire `server.registerTool('block_project', ...)` call (currently lines 424–452) with:

```ts
server.registerTool(
  'block_project',
  {
    description:
      "Block a project on an external dependency from scoping/in_progress. Cascades child work items in 'pending' and 'awaiting_input' to 'blocked' (claimed children are left running — Sapling cannot kill agent processes). The reserved failure_reason prefix 'project blocked: ' marks cascade-blocked rows so unblock_project can target them. Reason is required.",
    inputSchema: {
      id: z.number().int().positive(),
      reason: z.string().min(1),
    },
  },
  async ({ id, reason }) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const updProj = await client.query(
        `UPDATE projects
            SET status='blocked',
                failure_reason=$2,
                updated_at=now()
          WHERE id=$1 AND status IN ('scoping','in_progress')
         RETURNING *`,
        [id, reason],
      );
      if (updProj.rowCount === 0) {
        await client.query('ROLLBACK');
        const exists = await db.query(`SELECT id FROM projects WHERE id=$1`, [id]);
        if (exists.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `project ${id} not found`));
        return errorToToolResult(new AppError('conflict', `project ${id} is in a terminal state`));
      }

      const cascade = await client.query(
        `UPDATE work_items
            SET status='blocked',
                failure_reason=$2,
                updated_at=now()
          WHERE project_id=$1
            AND status IN ('pending','awaiting_input')`,
        [id, `project blocked: ${reason}`],
      );

      await client.query('COMMIT');
      return ok({ project: updProj.rows[0], cascade_blocked_count: cascade.rowCount ?? 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 2: Run the cascade tests to verify they pass**

```
pnpm --filter @sapling/mcp-server test -- projects-tools
```

Expected: the three cascade tests PASS, plus the original `block_project` tests still PASS.

- [ ] **Step 3: Run the full mcp-server test suite to catch regressions**

```
pnpm --filter @sapling/mcp-server test
```

Expected: all green.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts
git add packages/mcp-server/src/tools/projects.ts
git commit -m "feat(mcp-server): block_project cascades to pending and awaiting_input children"
```

---

## Task 4: unblock_project cascade + replay-all — failing tests

**Files:**

- Modify: `packages/mcp-server/test/integration/projects-tools.test.ts`

- [ ] **Step 1: Add unblock cascade and replay-all tests**

Inside the same `describe('block_project / unblock_project', ...)` block, add:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @sapling/mcp-server test -- projects-tools
```

Expected: both new tests FAIL — current `unblock_project` does not cascade-unblock children and only replays the single most-recent completion.

- [ ] **Step 3: Commit failing tests**

```bash
npx prettier --write packages/mcp-server/test/integration/projects-tools.test.ts
git add packages/mcp-server/test/integration/projects-tools.test.ts
git commit -m "test(mcp-server): unblock_project cascade + replay-all — failing tests"
```

---

## Task 5: unblock_project cascade + replay-all — implementation

**Files:**

- Modify: `packages/mcp-server/src/tools/projects.ts` (the `unblock_project` tool, currently lines 454–521)

- [ ] **Step 1: Replace the unblock_project handler**

Replace the entire `server.registerTool('unblock_project', ...)` call (currently lines 454–521) with:

```ts
server.registerTool(
  'unblock_project',
  {
    description:
      'Unblock a project. Recomputes target state from children: scoping if a scoping plan-type work item is still pending/claimed, else in_progress. Cascade-unblocks children whose failure_reason starts with the reserved prefix "project blocked: ". Replays auto-enqueue triggers by iterating *every* completed non-verifier child in completed_at order (the helper is idempotent).',
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
      const updProj = await client.query(
        `UPDATE projects
            SET status=$2, failure_reason=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, target],
      );

      // Cascade-unblock children carrying the reserved marker prefix.
      const cascade = await client.query(
        `UPDATE work_items
            SET status='pending',
                failure_reason=NULL,
                updated_at=now()
          WHERE project_id=$1
            AND status='blocked'
            AND failure_reason LIKE 'project blocked: %'`,
        [id],
      );

      // Replay every completion that happened during the blocked window, in chronological order.
      // The helper's per-plan-review and DoD-verifier branches are gated on "no existing review/verifier",
      // so replaying triggers that already fired is a no-op.
      const completions = await client.query<{
        id: number;
        project_id: number;
        plan_id: number | null;
        type: 'plan' | 'code' | 'review';
        is_dod_verifier: boolean;
      }>(
        `SELECT id, project_id, plan_id, type, is_dod_verifier
           FROM work_items
          WHERE project_id = $1 AND status = 'completed'
          ORDER BY completed_at ASC NULLS LAST, id ASC`,
        [id],
      );
      for (const row of completions.rows) {
        await advanceProjectAfterWorkCompletion(client, id, row);
      }

      await client.query('COMMIT');
      return ok({
        project: updProj.rows[0],
        cascade_unblocked_count: cascade.rowCount ?? 0,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
    } finally {
      client.release();
    }
  },
);
```

- [ ] **Step 2: Run the unblock tests to verify they pass**

```
pnpm --filter @sapling/mcp-server test -- projects-tools
```

Expected: cascade-unblock and replay-all tests PASS, plus all prior unblock tests still PASS.

- [ ] **Step 3: Run the full mcp-server suite**

```
pnpm --filter @sapling/mcp-server test
```

Expected: all green. The lifecycle test in `packages/mcp-server/test/integration/projects-lifecycle.test.ts` exercises the auto-enqueue path; verify it still passes.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/mcp-server/src/tools/projects.ts
git add packages/mcp-server/src/tools/projects.ts
git commit -m "feat(mcp-server): unblock_project cascades children and replays all completions"
```

---

## Task 6: update_runner_config — accept ntfy fields

**Files:**

- Modify: `packages/mcp-server/src/tools/runner_config.ts`
- Modify: `packages/mcp-server/test/integration/runner_config.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/mcp-server/test/integration/runner_config.test.ts` (inside the existing top-level `describe`, after the existing tests):

```ts
it('accepts ntfy_url, awaiting_input_nag_age_ms, awaiting_input_nag_repeat_ms', async () => {
  const out = (await client.call('update_runner_config', {
    ntfy_url: 'http://localhost:8080/sapling',
    awaiting_input_nag_age_ms: 60_000,
    awaiting_input_nag_repeat_ms: 300_000,
  })) as Record<string, unknown>;
  expect(out.ntfy_url).toBe('http://localhost:8080/sapling');
  expect(out.awaiting_input_nag_age_ms).toBe(60_000);
  expect(out.awaiting_input_nag_repeat_ms).toBe(300_000);
});

it('rejects empty-string ntfy_url with invalid_input', async () => {
  const raw = await client.callRaw('update_runner_config', { ntfy_url: '' });
  expect(raw.isError).toBe(true);
  const body = JSON.parse(raw.content[0].text) as { error: { code: string } };
  expect(body.error.code).toBe('invalid_input');
});

it('rejects non-positive nag thresholds with invalid_input', async () => {
  const raw = await client.callRaw('update_runner_config', { awaiting_input_nag_age_ms: 0 });
  expect(raw.isError).toBe(true);
});

it('get_runner_config returns the new fields with defaults', async () => {
  const out = (await client.call('get_runner_config', {})) as Record<string, unknown>;
  expect(out.ntfy_url).toBeNull();
  expect(out.awaiting_input_nag_age_ms).toBe(3600000);
  expect(out.awaiting_input_nag_repeat_ms).toBe(21600000);
});
```

(If the existing test file lacks setup that truncates `runner_config` between tests, add an explicit reset in `beforeEach`: `await db.pool.query("UPDATE runner_config SET ntfy_url=NULL, awaiting_input_nag_age_ms=DEFAULT, awaiting_input_nag_repeat_ms=DEFAULT WHERE id=1")`.)

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @sapling/mcp-server test -- runner_config
```

Expected: the four new tests FAIL — fields not accepted by the schema.

- [ ] **Step 3: Add the fields to the tool schema**

Modify `packages/mcp-server/src/tools/runner_config.ts`. In `update_runner_config`, change the `inputSchema` and `fields` array to:

```ts
inputSchema: {
  agent_command: z.string().min(1).optional(),
  max_concurrent: PositiveInt.optional(),
  poll_interval_ms: PositiveInt.optional(),
  claim_ttl_ms: PositiveInt.optional(),
  max_claim_attempts: PositiveInt.optional(),
  ntfy_url: z.string().min(1).nullable().optional(),
  awaiting_input_nag_age_ms: PositiveInt.optional(),
  awaiting_input_nag_repeat_ms: PositiveInt.optional(),
},
```

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
];
```

Note: `ntfy_url` is `nullable()` — explicitly passing `null` should clear it. The existing `if (v === undefined) continue` logic preserves that behavior because `null !== undefined`.

Also update the tool description to mention the new fields:

```ts
description:
  'Patch the singleton runner_config row. Only specified fields are updated; integer fields must be > 0. ntfy_url accepts null to disable notifications.',
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm --filter @sapling/mcp-server test -- runner_config
```

Expected: all PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/mcp-server/src/tools/runner_config.ts \
                    packages/mcp-server/test/integration/runner_config.test.ts
git add packages/mcp-server/src/tools/runner_config.ts \
        packages/mcp-server/test/integration/runner_config.test.ts
git commit -m "feat(mcp-server): update_runner_config accepts ntfy fields"
```

---

## Task 7: Runner mcp_client — list awaiting_input + extended config

**Files:**

- Modify: `packages/runner/src/mcp_client.ts`

- [ ] **Step 1: Add types and methods**

Edit `packages/runner/src/mcp_client.ts`. Update `RunnerConfig` and add `AwaitingInputItem` + `listAwaitingInput`:

```ts
export interface RunnerConfig {
  agent_command: string;
  max_concurrent: number;
  poll_interval_ms: number;
  claim_ttl_ms: number;
  max_claim_attempts: number;
  ntfy_url: string | null;
  awaiting_input_nag_age_ms: number;
  awaiting_input_nag_repeat_ms: number;
}

export interface AwaitingInputItem {
  id: number;
  title: string;
  updated_at: string; // ISO timestamp from the server
}

// in McpClient interface, add:
listAwaitingInput: () => Promise<AwaitingInputItem[]>;
```

In `wrapMcpClient`, add the implementation:

```ts
listAwaitingInput: () =>
  callJson<AwaitingInputItem[]>('list_work', { status: 'awaiting_input' }),
```

- [ ] **Step 2: Run runner tests to verify nothing regressed**

```
pnpm --filter @sapling/runner test
```

Expected: PASS (the change is purely additive — existing `listPendingWork` path unchanged).

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/runner/src/mcp_client.ts
git add packages/runner/src/mcp_client.ts
git commit -m "feat(runner): mcp_client lists awaiting_input + carries new RunnerConfig fields"
```

---

## Task 8: Notifier module + unit tests

**Files:**

- Create: `packages/runner/src/notifier.ts`
- Create: `packages/runner/test/notifier.test.ts`

- [ ] **Step 1: Write failing tests for the notifier**

Create `packages/runner/test/notifier.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { nagAwaitingInput, type NagDeps } from '../src/notifier.js';

function fixedNow(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

function buildDeps(overrides: Partial<NagDeps> = {}): NagDeps {
  return {
    items: [],
    ntfyUrl: 'http://localhost:8080/sapling',
    nagAgeMs: 60_000,
    nagRepeatMs: 300_000,
    lastNotified: new Map(),
    fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
    log: vi.fn(),
    now: fixedNow('2026-05-10T12:00:00.000Z'),
    ...overrides,
  };
}

describe('nagAwaitingInput', () => {
  it('returns count=0 and oldestAgeMs=0 when there are no items', async () => {
    const r = await nagAwaitingInput(buildDeps());
    expect(r).toEqual({ count: 0, oldestAgeMs: 0, nagged: 0 });
  });

  it('does not POST when ntfyUrl is null', async () => {
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        ntfyUrl: null,
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T11:00:00.000Z' }],
        fetchImpl,
      }),
    );
    expect(r.count).toBe(1);
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips items younger than nagAgeMs', async () => {
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T11:59:30.000Z' }], // 30s old
        nagAgeMs: 60_000,
        fetchImpl,
      }),
    );
    expect(r.count).toBe(1);
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs to ntfy for items older than nagAgeMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 7, title: 'plan a thing', updated_at: '2026-05-10T11:00:00.000Z' }], // 1h old
        fetchImpl,
      }),
    );
    expect(r.nagged).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8080/sapling');
    expect((init as RequestInit).method).toBe('POST');
    expect(String((init as RequestInit).body)).toContain('plan a thing');
    expect(String((init as RequestInit).body)).toContain('#7');
  });

  it('does not double-nag inside nagRepeatMs', async () => {
    const lastNotified = new Map<number, Date>([
      [1, new Date('2026-05-10T11:58:00.000Z')], // 2 min ago < 5 min repeat window
    ]);
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
        fetchImpl,
      }),
    );
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records last-notified time after a successful POST', async () => {
    const lastNotified = new Map<number, Date>();
    await nagAwaitingInput(
      buildDeps({
        items: [{ id: 9, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
      }),
    );
    expect(lastNotified.get(9)?.toISOString()).toBe('2026-05-10T12:00:00.000Z');
  });

  it('does not record last-notified time on HTTP failure and logs the error', async () => {
    const lastNotified = new Map<number, Date>();
    const log = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 9, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
        fetchImpl,
        log,
      }),
    );
    expect(r.nagged).toBe(0);
    expect(lastNotified.has(9)).toBe(false);
    expect(log).toHaveBeenCalledWith('notify_error', expect.any(Object));
  });

  it('reports oldestAgeMs across all items even when none are nagged', async () => {
    const r = await nagAwaitingInput(
      buildDeps({
        items: [
          { id: 1, title: 't', updated_at: '2026-05-10T11:59:30.000Z' }, // 30s
          { id: 2, title: 'u', updated_at: '2026-05-10T11:50:00.000Z' }, // 10m
        ],
        nagAgeMs: 24 * 60 * 60 * 1000, // disable nagging
      }),
    );
    expect(r.count).toBe(2);
    expect(r.oldestAgeMs).toBe(10 * 60 * 1000);
    expect(r.nagged).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module does not exist yet)**

```
pnpm --filter @sapling/runner test -- notifier
```

Expected: FAIL — `cannot find module ../src/notifier.js`.

- [ ] **Step 3: Create the notifier module**

Create `packages/runner/src/notifier.ts`:

```ts
export interface AwaitingInputItem {
  id: number;
  title: string;
  updated_at: string;
}

export interface NagDeps {
  items: AwaitingInputItem[];
  ntfyUrl: string | null;
  nagAgeMs: number;
  nagRepeatMs: number;
  lastNotified: Map<number, Date>;
  fetchImpl?: typeof fetch;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface NagResult {
  count: number;
  oldestAgeMs: number;
  nagged: number;
}

export async function nagAwaitingInput(deps: NagDeps): Promise<NagResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (deps.items.length === 0) {
    return { count: 0, oldestAgeMs: 0, nagged: 0 };
  }

  let oldestAgeMs = 0;
  for (const it of deps.items) {
    const age = now.getTime() - new Date(it.updated_at).getTime();
    if (age > oldestAgeMs) oldestAgeMs = age;
  }

  if (!deps.ntfyUrl) {
    return { count: deps.items.length, oldestAgeMs, nagged: 0 };
  }

  let nagged = 0;
  for (const it of deps.items) {
    const age = now.getTime() - new Date(it.updated_at).getTime();
    if (age < deps.nagAgeMs) continue;
    const last = deps.lastNotified.get(it.id);
    if (last && now.getTime() - last.getTime() < deps.nagRepeatMs) continue;

    const ageHuman = formatAge(age);
    const body = `Sapling work item #${it.id} has been awaiting input for ${ageHuman}: ${it.title}\nRun /sapling:human ${it.id} to answer.`;
    try {
      const res = await fetchImpl(deps.ntfyUrl, {
        method: 'POST',
        headers: {
          Title: 'Sapling: awaiting input',
          Tags: 'warning',
          Click: `sapling://human/${it.id}`,
        },
        body,
      });
      if (!res.ok) {
        deps.log?.('notify_error', { id: it.id, status: res.status });
        continue;
      }
      deps.lastNotified.set(it.id, now);
      nagged += 1;
    } catch (err) {
      deps.log?.('notify_error', { id: it.id, err: String(err) });
    }
  }

  return { count: deps.items.length, oldestAgeMs, nagged };
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm --filter @sapling/runner test -- notifier
```

Expected: all PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/runner/src/notifier.ts packages/runner/test/notifier.test.ts
git add packages/runner/src/notifier.ts packages/runner/test/notifier.test.ts
git commit -m "feat(runner): notifier module — POST awaiting_input to ntfy with throttle"
```

---

## Task 9: Wire notifier into tick + main

**Files:**

- Modify: `packages/runner/src/loop.ts`
- Modify: `packages/runner/src/index.ts`
- Modify: `packages/runner/test/loop.test.ts`

- [ ] **Step 1: Write a failing tick-level test**

Add to `packages/runner/test/loop.test.ts`, inside the existing `describe('runner loop tick', ...)`:

```ts
it('calls the notifier with awaiting_input items and returns awaiting_input count + nagged in TickResult', async () => {
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO work_items(type, title, description_markdown, status, updated_at)
     VALUES ('plan', 'paused thing', 'x', 'awaiting_input', now() - interval '2 hours')
     RETURNING id`,
  );
  const id = rows[0].id;
  await db.pool.query(
    `UPDATE runner_config
        SET ntfy_url = 'http://example.invalid/sapling',
            awaiting_input_nag_age_ms = 60_000,
            awaiting_input_nag_repeat_ms = 300_000
      WHERE id = 1`,
  );
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

  const stub = makeStubSpawn();
  const running = new Set<SpawnedAgent>();
  const notifierState = new Map<number, Date>();
  const r = await tick({
    mcp: fixture.mcp,
    spawn: stub.fn,
    env: {},
    running,
    notifierState,
    fetchImpl,
  });

  expect(r.awaiting_input).toBe(1);
  expect(r.nagged).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(notifierState.get(id)).toBeDefined();
});

it('does not call fetch when ntfy_url is null', async () => {
  await db.pool.query(
    `INSERT INTO work_items(type, title, description_markdown, status, updated_at)
     VALUES ('plan', 'p', 'x', 'awaiting_input', now() - interval '2 hours')`,
  );
  // ntfy_url defaults to NULL
  const fetchImpl = vi.fn();
  const stub = makeStubSpawn();
  const running = new Set<SpawnedAgent>();
  const notifierState = new Map<number, Date>();
  const r = await tick({
    mcp: fixture.mcp,
    spawn: stub.fn,
    env: {},
    running,
    notifierState,
    fetchImpl,
  });
  expect(r.awaiting_input).toBe(1);
  expect(r.nagged).toBe(0);
  expect(fetchImpl).not.toHaveBeenCalled();
});
```

Add the missing import at the top of the file: `import { vi } from 'vitest';` (replace the existing `import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';` line accordingly).

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @sapling/runner test -- loop
```

Expected: FAIL — `tick` does not yet accept `notifierState` / `fetchImpl` and does not return `awaiting_input` / `nagged`.

- [ ] **Step 3: Update tick()**

Modify `packages/runner/src/loop.ts` to:

```ts
import { nagAwaitingInput } from './notifier.js';
import type { McpClient } from './mcp_client.js';
import type { SpawnedAgent, SpawnFn } from './spawn.js';

export interface TickDeps {
  mcp: McpClient;
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  running: Set<SpawnedAgent>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** When provided, the notifier runs each tick and persists per-id last-notified times here. */
  notifierState?: Map<number, Date>;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TickResult {
  reaped: number;
  spawned: number;
  pending: number;
  running: number;
  awaiting_input: number;
  nagged: number;
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { mcp, spawn, env, running, log, notifierState, fetchImpl } = deps;

  const reaped = await mcp.reapStuckClaims();
  if (reaped.length > 0) log?.('reaped', { ids: reaped.map((r) => r.id) });

  const cfg = await mcp.getRunnerConfig();
  const pending = await mcp.listPendingWork();

  const available = Math.max(0, cfg.max_concurrent - running.size);
  const toSpawn = Math.min(available, pending.length);

  for (let i = 0; i < toSpawn; i++) {
    const child = spawn(cfg.agent_command, env);
    running.add(child);
    void child.onExit.then(() => {
      running.delete(child);
    });
    log?.('spawned', { pid: child.pid });
  }

  let awaiting = 0;
  let nagged = 0;
  if (notifierState) {
    const items = await mcp.listAwaitingInput();
    const r = await nagAwaitingInput({
      items,
      ntfyUrl: cfg.ntfy_url,
      nagAgeMs: cfg.awaiting_input_nag_age_ms,
      nagRepeatMs: cfg.awaiting_input_nag_repeat_ms,
      lastNotified: notifierState,
      fetchImpl,
      log,
    });
    awaiting = r.count;
    nagged = r.nagged;
    if (awaiting > 0) {
      log?.('awaiting_input', { count: awaiting, oldest_age_ms: r.oldestAgeMs, nagged });
    }
  }

  return {
    reaped: reaped.length,
    spawned: toSpawn,
    pending: pending.length,
    running: running.size,
    awaiting_input: awaiting,
    nagged,
  };
}
```

- [ ] **Step 4: Re-run loop tests to verify the new ones pass and the old ones still pass**

```
pnpm --filter @sapling/runner test -- loop
```

Expected: all PASS. Existing tests don't pass `notifierState`, so `awaiting_input` and `nagged` will be `0` for them — matching the existing `toMatchObject` assertions (which only check the keys they care about).

- [ ] **Step 5: Wire notifier state into main**

Modify `packages/runner/src/index.ts`. In `main()`:

- After `const running = new Set<SpawnedAgent>();` add `const notifierState = new Map<number, Date>();`.
- In the `doTick` function, change the `tick({ ... })` call to pass `notifierState` and `fetchImpl: globalThis.fetch`:

```ts
const r = await tick({
  mcp,
  spawn: spawnAgent,
  env: process.env,
  running,
  log,
  notifierState,
});
```

(`fetchImpl` defaults to global fetch inside `nagAwaitingInput`, so no need to pass it explicitly in production.)

- [ ] **Step 6: Run the full runner test suite to verify nothing regressed**

```
pnpm --filter @sapling/runner test
```

Expected: all green.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write packages/runner/src/loop.ts \
                    packages/runner/src/index.ts \
                    packages/runner/test/loop.test.ts
git add packages/runner/src/loop.ts \
        packages/runner/src/index.ts \
        packages/runner/test/loop.test.ts
git commit -m "feat(runner): wire ntfy notifier into tick + main loop"
```

---

## Task 10: Logger — surface awaiting_input on stdout

**Files:**

- Modify: `packages/runner/src/logger.ts`
- Modify: `packages/runner/test/logger.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/runner/test/logger.test.ts`, inside the `describe('createLogger', ...)`:

```ts
it('surfaces awaiting_input events to stdout when count > 0', () => {
  const { deps, cap } = makeDeps();
  const log = createLogger(deps);
  log('awaiting_input', { count: 3, oldest_age_ms: 4 * 60 * 60 * 1000, nagged: 1 });
  expect(cap.stdout).toHaveLength(1);
  expect(cap.stdout[0]).toContain('awaiting_input');
  expect(cap.stdout[0]).toContain('count=3');
  expect(cap.stdout[0]).toContain('oldest=4h');
});

it('skips awaiting_input on stdout when count is 0', () => {
  const { deps, cap } = makeDeps();
  const log = createLogger(deps);
  log('awaiting_input', { count: 0, oldest_age_ms: 0, nagged: 0 });
  expect(cap.stdout).toHaveLength(0);
  // file still gets it for completeness.
  expect(cap.file).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @sapling/runner test -- logger
```

Expected: FAIL — `awaiting_input` events currently fall through the generic non-tick branch and always print, so the second test fails. The first test may pass formatting but check the `oldest=4h` shape.

- [ ] **Step 3: Update the logger**

Modify `packages/runner/src/logger.ts`. Inside the returned closure, add an explicit branch for `awaiting_input` _before_ the generic fall-through (immediately after the `tick` branch ends and before the final `// Non-tick events` line):

```ts
if (msg === 'awaiting_input') {
  const count = Number(ctx?.count ?? 0);
  if (count === 0) return; // file already wrote it; suppress on stdout
  const oldestMs = Number(ctx?.oldest_age_ms ?? 0);
  const nagged = Number(ctx?.nagged ?? 0);
  const oldest = formatAge(oldestMs);
  deps.writeStdout(`[${time}] ⚠ awaiting_input count=${count} oldest=${oldest} nagged=${nagged}\n`);
  return;
}
```

Add the helper at the top of the file (next to `formatTime`):

```ts
function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm --filter @sapling/runner test -- logger
```

Expected: all PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/runner/src/logger.ts packages/runner/test/logger.test.ts
git add packages/runner/src/logger.ts packages/runner/test/logger.test.ts
git commit -m "feat(runner): surface awaiting_input on stdout when count > 0"
```

---

## Task 11: /sapling:status — show oldest awaiting_input age

**Files:**

- Modify: `packages/claude-plugin/skills/status/SKILL.md`
- Modify: `packages/claude-plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Update the skill's output spec**

In `packages/claude-plugin/skills/status/SKILL.md`, update the per-app section template line:

Change:

```
PENDING <p> CLAIMED <c> AWAITING <a> BLOCKED <b> FAILED <f>
```

to:

```
PENDING <p> CLAIMED <c> AWAITING <a> (oldest <oldest_age>) BLOCKED <b> FAILED <f>
```

And add a new bullet immediately after the line that says "Skip empty subsections (including the entire Projects header if no projects exist for that app) to keep the output dense.":

> If `awaiting_input` count > 0, compute `oldest_age` = the largest `now() - updated_at` across the awaiting_input rows for that app, formatted as `Nm` for < 60 minutes, `Nh` for < 48 hours, else `Nd`. Suppress the `(oldest …)` parenthetical entirely when the count is zero.

Update the cross-app totals line similarly:

```
TOTALS PROJECTS <P_total> PENDING <P> CLAIMED <C> AWAITING <A> (oldest <A_oldest>) BLOCKED <B> FAILED <F>
```

(Same suppression rule when `A == 0`.)

- [ ] **Step 2: Bump plugin version**

Edit `packages/claude-plugin/.claude-plugin/plugin.json`. Change `"version": "0.8.0"` to `"version": "0.8.1"`. Per `CLAUDE.md`: a wording change to a skill that affects observable agent behavior is a patch bump.

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/claude-plugin/skills/status/SKILL.md \
                    packages/claude-plugin/.claude-plugin/plugin.json
git add packages/claude-plugin/skills/status/SKILL.md \
        packages/claude-plugin/.claude-plugin/plugin.json
git commit -m "feat(plugin): /sapling:status shows oldest awaiting_input age (v0.8.1)"
```

---

## Task 12: docker-compose — add ntfy service

**Files:**

- Modify: `docker-compose.yml`

- [ ] **Step 1: Append the ntfy service**

Edit `docker-compose.yml`. Append, indented under the existing `services:` map (after `mcp-server`):

```yaml
ntfy:
  image: binwiederhier/ntfy:latest
  command: serve
  restart: unless-stopped
  environment:
    TZ: UTC
    NTFY_BASE_URL: http://localhost:8080
    NTFY_CACHE_FILE: /var/cache/ntfy/cache.db
    NTFY_AUTH_FILE: /var/lib/ntfy/user.db
    NTFY_BEHIND_PROXY: 'false'
    NTFY_LISTEN_HTTP: ':80'
  ports:
    - '127.0.0.1:8080:80'
  volumes:
    - ./data/ntfy/cache:/var/cache/ntfy
    - ./data/ntfy/lib:/var/lib/ntfy
```

(`./data/` is already in `.gitignore`, so no additional ignore entry is needed.)

- [ ] **Step 2: Smoke-test the compose file parses and the service starts**

```
docker compose config >/dev/null
docker compose up -d ntfy
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
```

Expected: `200` (ntfy's web UI serves HTML on `/`). If you get connection refused, check `docker compose logs ntfy`.

Then publish a smoke notification (won't reach a phone unless you've subscribed via the app):

```
curl -d 'hello from sapling' http://127.0.0.1:8080/sapling
```

Expected: a JSON response with `id`, `time`, `event: 'message'`.

Tear down:

```
docker compose down ntfy
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write docker-compose.yml
git add docker-compose.yml
git commit -m "feat(infra): self-hosted ntfy service in docker-compose"
```

---

## Task 13: Update SPEC.md

**Files:**

- Modify: `SPEC.md`

Per `CLAUDE.md`: "any change to MCP tool surface or runner config keys requires a SPEC.md update in the same commit / PR." We're keeping the tool count at 49 (no add/remove) but several tool descriptions, the lifecycle, the architecture diagram, and the config table need updates.

- [ ] **Step 1: Update § 2 non-goals**

Find the line:

> Webhooks, event bus, metrics export, outbound transports of any kind (discoverability is pull-based). Project-level Linear updates are emitted by agents through the Linear MCP they already have, not by the Sapling server — see [§ 12 Claude plugin](#12-claude-plugin).

Replace with:

> Webhooks, event bus, metrics export. Discoverability is pull-based; opt-in operator-targeted notifications via the runner-side ntfy notifier are permitted as an attention mechanism for `awaiting_input` items, not as a general transport. Project-level Linear updates are emitted by agents through the Linear MCP they already have, not by the Sapling server — see [§ 12 Claude plugin](#12-claude-plugin).

- [ ] **Step 2: Update § 3 architecture diagram**

In the ASCII docker-compose box, add a third service:

```
│  ┌─────────────────────┐         ┌─────────────────────┐    ┌────────────┐ │
│  │ mcp-server          │ ──SQL──▶│ postgres:16-alpine  │    │ ntfy       │ │
│  │ (Node 22 + TS, ESM) │         │ volume ./data/pg    │    │ (loopback) │ │
│  │ Express :3333 /mcp  │         │ port 5432 (loopback)│    │ port 8080  │ │
│  └──────────┬──────────┘         └─────────────────────┘    └─────▲──────┘ │
└─────────────┼────────────────────────────────────────────────────┼─────────┘
              │                                                    │
              │ Streamable HTTP MCP                                 │ POST (opt-in)
              │                                                    │ from runner
              ▼                                                    │
   ┌─────────────────────┐         ┌────────────────────┐          │
   │ Claude Code session │◀───────▶│ sapling-runner     │──────────┘
   │ (lead or solo agent)│  spawns │ (polling daemon)   │
   └─────────────────────┘         └────────────────────┘
```

Then add to the "Key decisions" list:

> - **Self-hosted ntfy** as a third compose service (loopback by default). The runner POSTs to it on stale `awaiting_input` items when `runner_config.ntfy_url` is set. Operator chooses an exposure path (Tailscale recommended, LAN, or Cloudflare Tunnel) — see README.

- [ ] **Step 3: Update § 5 data model — add migration 010 row**

In the migrations table:

| `010_runner_ntfy_config.sql` | Adds `ntfy_url` (TEXT, nullable), `awaiting_input_nag_age_ms` (INT NOT NULL DEFAULT 3600000), `awaiting_input_nag_repeat_ms` (INT NOT NULL DEFAULT 21600000) to `runner_config`. |

- [ ] **Step 4: Update § 7 — block_project + unblock_project descriptions**

Replace the `block_project` row with:

| `block_project(id, reason)` | Sets project `blocked` from `scoping` / `in_progress`. **Cascades**: child work items in `pending` or `awaiting_input` are flipped to `blocked` with `failure_reason = 'project blocked: <reason>'` (the reserved prefix marks cascade-blocked rows). `claimed` children are not touched — Sapling cannot kill the agent process. Returns `{ project, cascade_blocked_count }`. |

Replace the `unblock_project` row with:

| `unblock_project(id)` | Recomputes status (`scoping` if a scoping child is in-flight, else `in_progress`). **Cascade-unblocks** children whose `failure_reason` starts with the reserved prefix `'project blocked: '`. Replays `advanceProjectAfterWorkCompletion` for **every** completed non-verifier child in `completed_at` order (helper guards make this idempotent). Returns `{ project, cascade_unblocked_count }`. |

Add a note immediately under the project tools table:

> The `'project blocked: '` prefix on `failure_reason` is reserved. Operators must not use it in `block_work` reason text, or the row will be swept by `unblock_project`'s cascade-unblock.

- [ ] **Step 5: Update § 8 lifecycle diagram**

Update the project lifecycle box at the bottom of § 8 to:

```
   block_project   ──> blocked  ── unblock_project ──> (recomputed prior state)
                          │                           + cascade-unblock children
                          │                           + replay all completions
                          │  cascades to pending +
                          │  awaiting_input children
                          │  (claimed left alone)
```

- [ ] **Step 6: Update § 11 runner**

In the tick algorithm pseudocode, append:

```
8. if cfg.ntfy_url is set:
     awaiting = await mcp.listAwaitingInput()
     for each item with age >= awaiting_input_nag_age_ms
         and not nagged within awaiting_input_nag_repeat_ms:
       POST to cfg.ntfy_url; record lastNotifiedAt[id]
     log 'awaiting_input' { count, oldest_age_ms, nagged }
```

Add a paragraph below the algorithm:

> The notifier's per-item last-notified state is in-memory only — a runner restart re-nags each still-stale item once. Acceptable for v1; can be promoted to a `work_items.notified_at` column later if double-pings become noisy.

In the "Logging" subsection, append:

> When a tick reports `awaiting_input` count > 0, the runner emits an `awaiting_input` event line on stdout (formatted as `⚠ awaiting_input count=N oldest=Xh nagged=N`) regardless of idle status. The event is also written to the JSON file log.

- [ ] **Step 7: Update § 13 configuration surface**

Append three rows to the runner_config table:

| `ntfy_url` | `runner_config` table | `NULL` | When set, the runner POSTs notifications to this URL for stale `awaiting_input` items. `NULL` disables notifications. |
| `awaiting_input_nag_age_ms` | `runner_config` table | `3600000` (1 h) | Age threshold before an `awaiting_input` item is eligible for a nag. |
| `awaiting_input_nag_repeat_ms` | `runner_config` table | `21600000` (6 h) | Minimum interval between repeat nags for the same item. |

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write SPEC.md
git add SPEC.md
git commit -m "docs(spec): block_project cascade, unblock replay, ntfy notifier"
```

---

## Task 14: README — ntfy setup + Tailscale-recommended exposure

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a "Phone notifications" section**

Find the most natural place in `README.md` (after the runner section, or near the bottom under a "Notifications" header) and add:

````markdown
## Phone notifications (optional)

Sapling ships a self-hosted [ntfy](https://github.com/binwiederhier/ntfy) service in `docker-compose.yml`. When `runner_config.ntfy_url` is set, the runner POSTs a notification for every `awaiting_input` work item that has been waiting longer than `awaiting_input_nag_age_ms` (default 1 h), throttled by `awaiting_input_nag_repeat_ms` (default 6 h).

By default ntfy is bound to `127.0.0.1:8080` — your phone cannot reach it. Pick one exposure path:

### Tailscale (recommended)

1. Install [Tailscale](https://tailscale.com/) on your Mac and your phone; sign in to the same tailnet.
2. Find your Mac's tailnet IP (`tailscale ip`).
3. Edit `docker-compose.yml` and change the ntfy port mapping to bind to that IP, e.g. `100.64.0.10:8080:80`.
4. On your phone, install the ntfy app and subscribe to `http://<mac-tailnet-ip>:8080/sapling` (or any topic name you choose).
5. Set the runner config:
   ```bash
   echo "UPDATE runner_config SET ntfy_url='http://<mac-tailnet-ip>:8080/sapling' WHERE id = 1;" | make psql
   ```

Works anywhere both devices are online. No public exposure.

### LAN binding

1. Edit `docker-compose.yml` and change `127.0.0.1:8080:80` to `0.0.0.0:8080:80`.
2. Subscribe via your Mac's LAN IP from the phone.
3. Set the runner config to that LAN URL.

Works only on the same Wi-Fi as your Mac.

### Cloudflare Tunnel / ngrok

Expose ntfy via a tunnel; **enable ntfy auth first** (see [ntfy auth docs](https://docs.ntfy.sh/config/#access-control)). Subscribe via the public URL.

Works anywhere with internet. Requires auth setup.

### Disable

Set `ntfy_url` back to `NULL`:

```bash
echo "UPDATE runner_config SET ntfy_url=NULL WHERE id = 1;" | make psql
```
````

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write README.md
git add README.md
git commit -m "docs(readme): phone notifications via ntfy + Tailscale-recommended exposure"
```

---

## Task 15: Final verification

- [ ] **Step 1: Run the full test suite**

```
make test
```

Expected: all green across mcp-server and runner. If a test in a sibling area was incidentally broken by a shared signature change, fix it before continuing.

- [ ] **Step 2: Smoke-test the runner end-to-end with ntfy**

```
docker compose up -d
make runner &
RUNNER_PID=$!
# Insert a stale awaiting_input row and configure the notifier
docker compose exec -T postgres psql -U sapling -d sapling -c "
  INSERT INTO work_items(type, title, description_markdown, status, updated_at)
  VALUES ('plan','smoke test','x','awaiting_input', now() - interval '2 hours');
  UPDATE runner_config
     SET ntfy_url = 'http://localhost:8080/sapling',
         awaiting_input_nag_age_ms = 60000,
         awaiting_input_nag_repeat_ms = 300000
   WHERE id = 1;
"
# Wait one poll interval (default 30s)
sleep 35
# Check ntfy received the message
curl -s 'http://127.0.0.1:8080/sapling/json?poll=1' | head -50
# Tear down
kill $RUNNER_PID
docker compose down
```

Expected: `ntfy/json?poll=1` shows a JSON message with title `Sapling: awaiting input` and a body referencing `#<id>`. Runner stdout shows `⚠ awaiting_input count=1 oldest=2h nagged=1`.

- [ ] **Step 3: Verify SPEC.md still parses + reflects reality**

```
grep -c "Total:" SPEC.md           # should still report 49 tools
grep -n "ntfy_url" SPEC.md          # should appear in § 13
grep -n "010_runner_ntfy_config" SPEC.md  # should appear in § 5
grep -n "cascade_blocked_count" SPEC.md   # should appear in § 7
```

Expected: each grep returns at least one matching line.

- [ ] **Step 4: Push the branch / open the PR (operator decision)**

Stop here and wait for the operator to review and push. Do not push without explicit confirmation.

---

## Self-Review (against the spec, before declaring the plan complete)

**1. Spec coverage:**

- § What changes / 1 (block_project cascade): Tasks 2–3.
- § What changes / 2 (unblock cascade + replay-all): Tasks 4–5.
- § What changes / 3 (visibility): Task 10 (logger) + Task 11 (skill).
- § What changes / 4 (ntfy + notifier): Task 1 (migration) + Task 6 (config tool) + Task 7 (mcp_client) + Task 8 (notifier) + Task 9 (wire-in) + Task 12 (compose).
- § What changes / 5 (SPEC updates): Task 13.
- § Files touched: every entry maps to a task.
- § Tests: Task 2 (block cascade), Task 4 (unblock cascade + replay-all), Task 6 (config), Task 8 (notifier unit), Task 9 (notifier integration), Task 10 (logger).
- § Out of scope items: respected — no `claim_next_work` change, no `blocked_by_project_id` column, no agent-killing.

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or vague instructions. Every code step contains the actual code or SQL. Every command shows the expected output. The README copy includes literal config commands.

**3. Type consistency:**

- `cascade_blocked_count` and `cascade_unblocked_count` (snake case) used identically in tool returns (Task 3, 5), tests (Task 2, 4), and SPEC (Task 13).
- `nagAwaitingInput` / `NagDeps` / `NagResult` consistent across notifier module (Task 8), tests (Task 8), and tick wiring (Task 9).
- `RunnerConfig` interface in `mcp_client.ts` (Task 7) carries the same field names as the migration (Task 1) and the `update_runner_config` schema (Task 6): `ntfy_url`, `awaiting_input_nag_age_ms`, `awaiting_input_nag_repeat_ms`.
- `AwaitingInputItem` shape (Task 7, 8) consistent: `{ id, title, updated_at }`.
- Logger event name `'awaiting_input'` matches between `tick()` (Task 9), logger handler (Task 10), and SPEC § 11 (Task 13).
- ntfy URL example `http://localhost:8080/sapling` consistent across config defaults, smoke test (Task 15), README (Task 14), and SPEC.

No drift detected. Plan ready to execute.
