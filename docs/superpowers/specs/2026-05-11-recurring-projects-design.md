# Recurring projects — design

> Status: design accepted, plan pending.
> Author: brainstormed 2026-05-11 with @cfarvidson.
> Supersedes: nothing. Adds a new scheduler subsystem to mcp-server.

## 1. Problem

Sapling has no way to enqueue work on a recurring cadence. Every project is created by a human running `/sapling:project create` or by the `complete_scoping` fan-out triggered from another project. Workflows like "review all repos in app X every 6 hours" or "scan our GitHub org for stale dependencies every weeknight at 9pm" have no place to live and are run manually or not at all.

## 2. Goals and non-goals

### Goals

1. Enqueue **a project** on a cron schedule, fully reusing the existing `create_project` lifecycle (per-service plan fan-out, DoD verification, cascade behavior).
2. Support two source types per schedule:
   - **`app`** — services already registered in Sapling under one app.
   - **`github_org`** — repos discovered live from a GitHub org at fire time; new repos auto-create thin services under a designated app.
3. Cron-expression triggers with IANA timezones.
4. Per-schedule overlap policy: skip if previous spawned project is still in-flight, or always fire.
5. Operator surface: a `/sapling:schedule` slash command (list / show / create / edit / enable / disable / run / delete) and a one-line addition to `/sapling:status`.
6. Audit history queryable via SQL (`schedule_runs` table).

### Non-goals (v1)

- Catch-up runs for missed ticks. A disabled or backlogged schedule fires once on resume; missed ticks are silently dropped.
- Webhooks. GitHub repo discovery is pull-only at fire time.
- GitHub App auth. Personal access token only.
- Multi-org schedules. One schedule = one org.
- Per-repo filters beyond the org-wide `github_default_visibility`.
- Notifications on schedule failure beyond the existing `/sapling:status` surface. No ntfy push.
- Backfill or replay tools.
- Per-schedule concurrency limits beyond the binary overlap policy.

## 3. Architecture

The scheduler runs **inside mcp-server**. A `setInterval` started in `index.ts` after migrations complete polls due schedules every `SCHEDULER_TICK_MS` (default 10000). The tick reads a small index, fires due schedules serially, and advances each schedule's `next_run_at`.

```
┌──────────────────────── mcp-server (Node) ──────────────────────────┐
│                                                                     │
│   Express :3333/mcp ─── MCP tools (existing 49 + 8 new)             │
│                                                                     │
│   setInterval(SCHEDULER_TICK_MS) ── scheduler.tick()                │
│        │                                                            │
│        ├─ SELECT FROM schedules WHERE enabled AND next_run_at<=now  │
│        ├─ for each due:                                             │
│        │     ├─ (github_org) → Octokit.listOrgRepos → upsert svcs   │
│        │     ├─ overlap check via schedule_runs                     │
│        │     ├─ call createProject()                                │
│        │     ├─ INSERT schedule_runs(status, project_id, …)         │
│        │     └─ UPDATE schedules SET next_run_at = cron.next(…)     │
│        └─ structured pino logs (schedule_tick, schedule_fire)       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
  postgres                       api.github.com
  (schedules,                    (PAT in runner_config.github_token)
   schedule_runs)
```

The scheduler does **not** spawn processes. It only writes to the DB. The existing `sapling-runner` continues to drain the `pending` queue and is unaffected.

## 4. Data model

New migration `packages/mcp-server/src/schema/011_schedules.sql`.

### `schedules`

```sql
CREATE TYPE schedule_source AS ENUM ('app', 'github_org');
CREATE TYPE schedule_overlap AS ENUM ('skip_if_running', 'always_fire');

CREATE TABLE schedules (
  id                       serial PRIMARY KEY,
  name                     text NOT NULL UNIQUE,
  source_type              schedule_source NOT NULL,
  app_id                   int NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_org               text,
  cron_expr                text NOT NULL,
  timezone                 text NOT NULL DEFAULT 'UTC',
  overlap_policy           schedule_overlap NOT NULL DEFAULT 'skip_if_running',
  title_template           text NOT NULL,
  description_md           text NOT NULL,
  definition_of_done_md    text NOT NULL,
  enabled                  boolean NOT NULL DEFAULT true,
  last_fired_at            timestamptz,
  next_run_at              timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source_type = 'app' AND github_org IS NULL)
    OR (source_type = 'github_org' AND github_org IS NOT NULL)
  )
);

CREATE INDEX schedules_due_idx ON schedules(next_run_at) WHERE enabled = true;
```

Notes:

- `app_id NOT NULL` for both source types. A GitHub-org schedule still lands its discovered services and resulting projects under a designated Sapling app.
- `ON DELETE CASCADE` on `app_id` mirrors `services.app_id`: deleting an app deletes its schedules.
- `next_run_at` is denormalized so the tick query is a single indexed scan against `schedules_due_idx`.
- `name` is globally unique (not per-app). Schedules are operator-facing; one global namespace keeps slash-command UX simple.
- `title_template` supports two tokens at fire time: `{{date}}` (yyyy-mm-dd in the schedule's tz) and `{{iso_date}}` (ISO 8601 instant). Other text is passed through literally.

### `schedule_runs`

```sql
CREATE TYPE schedule_run_status AS ENUM ('fired', 'skipped_overlap', 'failed');

CREATE TABLE schedule_runs (
  id            serial PRIMARY KEY,
  schedule_id   int NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  status        schedule_run_status NOT NULL,
  project_id    int REFERENCES projects(id) ON DELETE SET NULL,
  error         text,
  duration_ms   int
);

CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at DESC);
```

Notes:

- One row per fire attempt, including overlap-skips and failures. This keeps the audit complete and lets `/sapling:status` show "we wanted to fire but didn't."
- `project_id` is the bridge to the existing project lifecycle. `ON DELETE SET NULL` so deleting a project preserves the audit row.
- `CASCADE` on `schedule_id` so deleting a schedule wipes its history.

### `runner_config` extensions

```sql
ALTER TABLE runner_config
  ADD COLUMN github_token text,
  ADD COLUMN github_default_visibility text DEFAULT 'all';
```

- `github_token` is nullable. Schedules with `source_type='github_org'` can be **created** before the token is set; they fail at fire time with a clear error rather than at create time. This makes ordering of setup steps flexible.
- `github_default_visibility` is `'all' | 'public' | 'private'`. No per-schedule override in v1.
- `github_token` is never logged, never returned by `get_runner_config` (redacted to `'***'` if set, `null` if unset). `update_runner_config` accepts `null` to clear. The existing `tool_call` structured log line includes only `{ tool, durationMs, ok }` (no args), so the token does not leak through that path either.

## 5. Lifecycle

### Tick loop

```ts
async function tick() {
  const due = await pool.query(`
    SELECT * FROM schedules
     WHERE enabled = true AND next_run_at <= now()
     ORDER BY next_run_at ASC
     FOR UPDATE SKIP LOCKED
  `);
  for (const s of due.rows) {
    await fireSchedule(s);
  }
}
```

Serial fire is intentional. Each fire is fast (a few DB writes plus at most one GitHub call). `FOR UPDATE SKIP LOCKED` is belt-and-braces against future horizontal scaling — only one mcp-server runs today.

### Fire path — `source_type='app'`

In one transaction:

1. **Resolve services.** `SELECT id FROM services WHERE app_id = $1`. Empty → `schedule_runs.status='failed'`, `error='no services in app'`, advance `next_run_at`, return.
2. **Overlap check.** If `overlap_policy = 'skip_if_running'`, look up the most recent `schedule_runs` row for this schedule. If its `project_id` is non-NULL and that project's status is in (`pending`, `scoping`, `in_progress`, `blocked`) → insert `schedule_runs(status='skipped_overlap')`, advance `next_run_at`, return.
3. **Render title.** Substitute `{{date}}` and `{{iso_date}}` (computed in the schedule's `timezone`).
4. **Create project.** Call the existing internal `createProject` function with `{ app_id, title, description_md, definition_of_done_md, service_ids: resolved }`. Same code path as the `create_project` MCP tool — same validations, same fan-out of plan work items.
5. **Record run.** `INSERT INTO schedule_runs(schedule_id, status='fired', project_id, duration_ms)`.
6. **Advance.** `UPDATE schedules SET last_fired_at = now(), next_run_at = nextCronTick(cron_expr, timezone, now())`.

If any step throws, the transaction rolls back. A separate non-transactional `INSERT INTO schedule_runs(status='failed', error=…)` is then made, and `next_run_at` is still advanced via a separate update. We do **not** want a broken schedule to refire every tick.

### Fire path — `source_type='github_org'`

Adds a discovery step before step 1 of the app path. Discovery happens **outside** the DB transaction; the transaction opens only once the resolved service list is known.

```
0a. Read runner_config.github_token. NULL → fail run with 'github_token not configured'.
0b. octokit.paginate(repos.listForOrg, { org, visibility: github_default_visibility })
0c. Filter out archived repos.
0d. For each repo:
      existing = SELECT id FROM services WHERE app_id = $1 AND repo_url = $2
      if existing → reuse id
      else → INSERT services(app_id, name, repo_url, description)
             with description = 'auto-created by schedule N'
0e. Pass the resolved service_ids list into the app-source path from step 2 onward.
```

GitHub failures (auth, rate-limit, network) at step 0b → `schedule_runs.status='failed'`, `error` captures the Octokit error message, `next_run_at` advances. No backoff — the next scheduled tick simply tries again.

### State diagram (per fire)

```
                           tick due
                              │
                              ▼
                     enabled = true?
                              │ yes
                              ▼
            source_type? ── app ── resolve services from DB
                  │                       │
              github_org                  │
                  │                       │
        token set? ── no → fail           │
                  │ yes                   │
        list org repos                    │
                  │                       │
        upsert services                   │
                  └───────► resolved service_ids ◄────────┘
                              │
                              ▼
              overlap_policy = skip_if_running?
                              │
              yes ──► prior project non-terminal? ── yes ──► record skip; advance
                              │
                              no
                              ▼
                       create_project
                              │
                              ▼
                  record run(fired); advance next_run_at
```

### Cron next-tick

`cron-parser` (npm) is the chosen library. ~50 KB; zero runtime dependencies; widely used. The wrapper at the call site treats parse errors at create/update time as `bad_request` and at tick time as a defensive `failed` run (should be unreachable).

Five-field cron only (`m h dom mon dow`). No seconds field. No `@daily`/`@hourly` shorthand at the tool layer — the `/sapling:schedule create` skill translates those before calling `create_schedule`, so the tool API surface only ever sees expanded 5-field cron strings.

## 6. MCP tool surface

Eight tools in `packages/mcp-server/src/tools/schedules.ts`. Registered in `tools/register.ts`. Bumps the SPEC tool count from **49 → 57**.

| Tool | Purpose |
|---|---|
| `create_schedule({ name, source_type, app_name, github_org?, cron_expr, timezone?, overlap_policy?, title_template, description_md, definition_of_done_md })` | Validates cron + timezone. For `github_org`, requires `github_org` non-empty. Computes `next_run_at`. Returns the schedule. |
| `get_schedule(id_or_name)` | Returns `{ schedule, last_run, last_5_runs, next_run_at }`. |
| `list_schedules({ app_name?, source_type?, enabled? })` | Filtered list. Includes `last_fired_at` and `next_run_at`. |
| `update_schedule(id, { cron_expr?, timezone?, overlap_policy?, title_template?, description_md?, definition_of_done_md? })` | Patch. Changing `cron_expr` / `timezone` recomputes `next_run_at`. `source_type`, `app_id`, `github_org`, `name` are not patchable — recreate. |
| `delete_schedule(id)` | Hard delete. Cascades `schedule_runs`. Does not touch spawned projects. |
| `enable_schedule(id)` / `disable_schedule(id)` | Flip `enabled`. Enabling recomputes `next_run_at` from now. Disabling does not cancel in-flight projects. |
| `run_schedule_now(id)` | Out-of-band fire. Same path as the tick, ignoring `next_run_at`. **Honors `overlap_policy`** — `run_schedule_now` on a schedule whose previous project is in-flight under `skip_if_running` records a `skipped_overlap` run. |

`get_runner_config` returns `github_token` as `'***'` if set, `null` if unset. `update_runner_config` accepts `github_token` and `github_default_visibility` as optional fields; `github_token` accepts `null` to clear.

Existing tools — `create_project`, `complete_work`, `cancel_project`, etc. — are unchanged. The scheduler calls the internal `createProject` function, not the MCP tool wrapper, so it runs in the same transaction as the `schedule_runs` insert.

## 7. GitHub source integration

`packages/mcp-server/src/github.ts` — one file, ~80 LOC.

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
): Promise<DiscoveredRepo[]>;
```

- Uses `octokit.paginate(octokit.rest.repos.listForOrg, …)`.
- Filters archived repos before returning.
- No caching. At most one call per schedule fire.

Dependency: `@octokit/rest` added to `packages/mcp-server/package.json`. Pinned to a specific minor.

### Edge cases

| Case | Behavior |
|---|---|
| `github_token` NULL at fire time | `schedule_runs.status='failed'`, `error='github_token not configured'`. `next_run_at` advances. |
| GitHub rate-limited (403) or 5xx | Failure recorded. No backoff. Next scheduled tick retries. |
| Repo renamed on GitHub | New `clone_url` doesn't match existing service → auto-created as new service. Old service becomes orphaned. Documented limitation. Operator can manually fix `repo_url` or delete the orphan. |
| Org with zero repos | `failed`, `error='no repos discovered for org X'`. |
| Network failure mid-pagination | Octokit error propagates; whole fire fails. No partial service creation (discovery completes before any DB writes). |
| Repo exists in multiple Sapling apps | Service lookup is scoped by `app_id`; the schedule's `app_id` decides where the (re)used service lives. No global dedup. |

## 8. Plugin / slash command

New skill `packages/claude-plugin/skills/schedule/SKILL.md`. Surface: `/sapling:schedule [<action> [args…]]`.

| Invocation | Behavior |
|---|---|
| `/sapling:schedule` | List all schedules grouped by app. |
| `/sapling:schedule show <id_or_name>` | `get_schedule` + last 5 runs + next 3 cron fire times. |
| `/sapling:schedule create` | Interactive walk-through. Accepts cron shorthand (`@daily`, `@hourly`, `@weekly`) and translates before calling. Shows rendered `title_template` example and next 3 fire times before confirming. For `github_org` source, calls `get_runner_config` first and warns if `github_token` is unset. |
| `/sapling:schedule edit <id>` | Interactive patch. |
| `/sapling:schedule enable <id>` / `disable <id>` | Direct tool calls. |
| `/sapling:schedule run <id>` | `run_schedule_now`. Prints spawned `project_id` + a link to `/sapling:project show <id>`. |
| `/sapling:schedule delete <id>` | Confirmation prompt (cascade warning), then `delete_schedule`. |

### `/sapling:status` extension

When at least one schedule exists, the existing status output gains a section:

```
Schedules: 3 enabled, 1 disabled
  Next fire: 2026-05-18 09:00 UTC — "Weekly repo review" (in 2h 14m)
  Last failure: 2026-05-17 09:00 UTC — "Weekly repo review" (github_token not configured)
```

Omitted entirely when no schedules exist — matches how the skill already handles `awaiting_input`.

### Plugin version

`packages/claude-plugin/.claude-plugin/plugin.json`: minor bump (e.g. `0.9.0 → 0.10.0`). New slash command is a user-visible behavior change.

## 9. Error handling

Reuses `errors.ts`. Tool-layer codes:

| Failure | Code |
|---|---|
| Invalid cron expression | `bad_request` |
| Unknown IANA timezone | `bad_request` |
| `github_org` source with missing `github_org` string | `bad_request` |
| Schedule name collision | `conflict` |
| Schedule not found | `not_found` |
| Unknown `id_or_name` to `get_schedule` | `not_found` |

Tick-time failures (GitHub auth, missing services in app, project insertion failure) have no MCP caller — they are recorded as `schedule_runs.status='failed'` with `error` populated, and `next_run_at` is advanced.

## 10. Observability

Two layers, no external metrics.

1. **Structured pino log lines** in the scheduler tick, matching the existing `tool_call` style:
   ```json
   {"event":"schedule_tick","durationMs":12,"due":2,"fired":1,"skipped":1,"failed":0}
   {"event":"schedule_fire","schedule_id":3,"source_type":"github_org","project_id":42,"status":"fired","durationMs":820}
   ```
2. **`schedule_runs` table** is the queryable history.

No ntfy notifications on schedule failure. Operators discover failures via `/sapling:status` (which already shows the most recent failure across schedules) or `/sapling:schedule show <id>`. Documented as a deliberate v1 carve-out, consistent with the existing "pull-based discoverability" non-goal in SPEC §2.

## 11. Testing

Reuses the existing vitest + testcontainers harness in `packages/mcp-server/test/`.

| Layer | Tests |
|---|---|
| Migration | `011_schedules.sql` applies on empty DB and on a DB at the current migration head. Constraints fire (`CHECK` on source_type/github_org, `UNIQUE` on name). |
| Tool unit | Each of the 8 new tools: happy path + each documented error code. Cron / timezone validation. `update_schedule` rejecting non-patchable fields. `get_runner_config` redacting `github_token`. |
| Tick integration | Cases: due/not-due selection respects `enabled`; `skip_if_running` correctly skips when prior project is non-terminal across each non-terminal status; `always_fire` ignores prior state; `next_run_at` advances exactly once even when the inner transaction rolls back; failed runs leave a `schedule_runs` row with `error` populated; serial fire ordering by `next_run_at ASC`. |
| GitHub source | Octokit mocked via a `__mocks__/@octokit/rest.ts` module. Cases: 0/1/N repos, archived-repo filtering, missing token at fire time, 403/5xx, repo rename creates orphan, repo exists in another app does not collide. No real GitHub calls in CI. |
| Plugin skill | No code; manual smoke against a running `make up`. |

## 12. SPEC.md updates required in the same commit

- **§ 3 Architecture** — add a scheduler arrow inside the mcp-server box.
- **§ 5 Data model** — add `011_schedules.sql` to the migration table; add `schedules`, `schedule_runs` to the table list; document the `runner_config` additions.
- **§ 7 MCP tool surface** — update header tool count from **49 → 57**; add a "Schedules (`tools/schedules.ts`) — 8 tools" subsection.
- **§ 13 Configuration surface** — add `github_token` (nullable) and `github_default_visibility` (`'all'`) to the `runner_config` keys table.
- **§ 2 Non-goals** — add the carve-outs listed in section 2 of this doc (no catch-up runs; no GitHub webhooks; no GitHub App auth; no multi-org; no scheduler-failure notifications).

## 13. Out of scope (future work)

- Catch-up / coalesce missed runs on resume.
- GitHub App auth and webhook ingestion.
- Multi-org schedules, repo-topic filters, per-repo visibility overrides.
- Per-schedule concurrency caps beyond skip/always.
- Notifications on schedule failure (ntfy or otherwise) — depends on a broader notifier strategy.
- A `restore_orphan_service(old_service_id, new_service_id)` reconciler for renamed GitHub repos.
- Exposing schedules to the runner so a runner restart can recompute `next_run_at` for "drifted" schedules (today, restart of mcp-server does this naturally; the scheduler picks up wherever `next_run_at` says).
