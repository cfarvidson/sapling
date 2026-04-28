# Sapling — MCP Dev Workbench

**Status:** Draft for implementation
**Date:** 2026-04-28
**Author:** Carl-Fredrik Arvidson (with brainstorming assistant)

## Summary

Sapling is an AI-native dev workbench: a Postgres-backed knowledge store and typed work queue exposed to Claude Code (and other agents) via MCP. It gives the agent a single durable place for plans, design docs, review notes, and product knowledge — and a queue from which it can pull planning, coding, and review tasks.

Sapling does not run agents. The current Claude session pulls work and executes it locally. Sapling is the workbench, not the worker.

## Goals

1. **One place for plans.** Every plan the agent generates lives in Postgres, queryable, linkable, statusable.
2. **One place for in-flight dev work.** Typed work items (plan / code / review) with cross-references so chains are coherent.
3. **One place for product knowledge.** Apps and the services that compose them, with enough metadata that an agent can ground itself before acting.
4. **One verb to start work.** `/sapling:work` claims the next pending task and executes it in the current Claude session.

## Non-Goals (v1)

- Web UI, REST API, standalone CLI.
- Multi-user, auth beyond an optional bearer token.
- Background workers, agent process orchestration.
- Mirroring or storing repo source code (real code stays in git).
- Vector search / embeddings.
- Webhooks, event bus, metrics export.
- Automated backups (filesystem volume is the recovery surface).

## Architecture

Two services in a single `docker-compose.yml`:

```
┌──────────────────────────────────────────────────────────────┐
│  docker-compose                                              │
│                                                              │
│  ┌────────────────────┐         ┌─────────────────────┐      │
│  │ mcp-server         │ ──SQL─► │ postgres            │      │
│  │ (TypeScript, Node) │         │ (official image)    │      │
│  │ HTTP/SSE :3333     │         │ port 5432 internal  │      │
│  └─────────┬──────────┘         └──────────┬──────────┘      │
│            │                               │                 │
└────────────┼───────────────────────────────┼─────────────────┘
             │                               │
       Claude Code                    persistent volume
       (HTTP/SSE on                   (./data/postgres)
        localhost:3333)
```

**Key decisions:**

- Single Node process. One user, local box, no clustering.
- Migrations applied on server startup. Idempotent. Tracked in `_migrations` table.
- HTTP/SSE bound to `127.0.0.1:3333` so it's not network-reachable.
- Optional bearer auth via `MCP_TOKEN` env var; off by default.
- Postgres data persisted to `./data/postgres` (gitignored).

**Repo layout:**

```
sapling/
  docker-compose.yml
  Makefile
  packages/
    mcp-server/
      src/
        index.ts          # bootstrap: MCP server + HTTP/SSE
        db.ts             # pg pool
        migrate.ts        # startup migrator
        tools/
          products.ts
          plans.ts
          work.ts
          artifacts.ts
        schema/
          001_init.sql
      package.json
      tsconfig.json
      Dockerfile
    claude-plugin/
      .claude/
        skills/
          sapling-work/
          sapling-plan/
          sapling-enqueue/
          sapling-status/
          sapling-context/
  .env.example
  README.md
  docs/superpowers/specs/
```

**Claude Code config (added to `~/.claude.json` or project `.mcp.json`):**

```json
{
  "mcpServers": {
    "sapling": {
      "type": "sse",
      "url": "http://localhost:3333/sse"
    }
  }
}
```

## Data Model

```sql
-- Products: hierarchical (app -> services)

CREATE TABLE apps (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id           SERIAL PRIMARY KEY,
  app_id       INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  repo_url     TEXT,
  description  TEXT,
  tech_stack   TEXT[] NOT NULL DEFAULT '{}',
  depends_on   TEXT[] NOT NULL DEFAULT '{}',
  conventions  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

-- Plans

CREATE TYPE plan_status AS ENUM ('draft','active','completed','archived');

CREATE TABLE plans (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  status          plan_status NOT NULL DEFAULT 'draft',
  service_id      INT REFERENCES services(id) ON DELETE SET NULL,
  parent_plan_id  INT REFERENCES plans(id)    ON DELETE SET NULL,
  body_markdown   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plans_service_idx ON plans(service_id);
CREATE INDEX plans_status_idx  ON plans(status);

-- Work queue

CREATE TYPE work_type   AS ENUM ('plan','code','review');
CREATE TYPE work_status AS ENUM ('pending','claimed','completed','failed','cancelled');

CREATE TABLE work_items (
  id                   SERIAL PRIMARY KEY,
  type                 work_type   NOT NULL,
  status               work_status NOT NULL DEFAULT 'pending',
  title                TEXT NOT NULL,
  description_markdown TEXT NOT NULL,
  priority             INT  NOT NULL DEFAULT 0,
  service_id           INT  REFERENCES services(id) ON DELETE SET NULL,
  plan_id              INT  REFERENCES plans(id)    ON DELETE SET NULL,
  branch               TEXT,
  pr_url               TEXT,
  claimed_at           TIMESTAMPTZ,
  claimed_by           TEXT,
  completed_at         TIMESTAMPTZ,
  failure_reason       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_pending_idx ON work_items(priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX work_status_idx  ON work_items(status);

-- Artifacts (markdown blobs produced by agents)

CREATE TABLE artifacts (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  work_item_id  INT REFERENCES work_items(id) ON DELETE SET NULL,
  plan_id       INT REFERENCES plans(id)      ON DELETE SET NULL,
  service_id    INT REFERENCES services(id)   ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_work_idx ON artifacts(work_item_id);
CREATE INDEX artifacts_plan_idx ON artifacts(plan_id);

-- Migration tracking

CREATE TABLE _migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Schema notes:**

- `tech_stack` and `depends_on` are `TEXT[]`. Lean for v1; can promote to a join table later.
- All FKs use `ON DELETE SET NULL` except `services.app_id`, which cascades — deleting a plan must not nuke its work history.
- `work_pending_idx` is a partial index — keeps the claim query O(log N) regardless of completed-task volume.
- `artifacts` can attach to any of work / plan / service, all optional. Flexible without being chaotic.

## MCP Tool Surface

19 tools, four families. All inputs validated by `zod`; all outputs JSON; all errors carry a human-readable `message`.

**Products:**

| Tool                                                                                                | Purpose                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `list_apps()`                                                                                       | All apps.                                              |
| `list_services(app_name?)`                                                                          | Services, optionally filtered to one app.              |
| `get_service(id_or_name)`                                                                           | Full detail incl. tech_stack, depends_on, conventions. |
| `register_app(name, description?)`                                                                  | Create app.                                            |
| `register_service(app_name, name, repo_url?, description?, tech_stack?, depends_on?, conventions?)` | Create service.                                        |
| `update_service(id, ...partial)`                                                                    | Patch any field.                                       |

**Plans:**

| Tool                                                                              | Purpose                                 |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| `create_plan(title, body_markdown, service_id?, parent_plan_id?, status='draft')` | Store a plan.                           |
| `get_plan(id)`                                                                    | Fetch with body.                        |
| `list_plans(service_id?, status?)`                                                | Filtered list (titles only, no bodies). |
| `update_plan(id, ...partial)`                                                     | Patch title/body/status/links.          |

**Work queue:**

| Tool                                                                                                  | Purpose                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `enqueue_work(type, title, description_markdown, priority?, service_id?, plan_id?, branch?, pr_url?)` | Add a task. Type ∈ {plan, code, review}.                                                                          |
| `claim_next_work(claimed_by, types?, service_id?)`                                                    | **Atomic.** Returns next pending item matching filters, marks it `claimed`. Returns `null` if none.               |
| `get_work(id)`                                                                                        | Fetch one.                                                                                                        |
| `list_work(status?, type?, service_id?, plan_id?)`                                                    | Filtered list.                                                                                                    |
| `complete_work(id, summary_markdown?, artifact_id?)`                                                  | Mark completed; optional summary stored as artifact, or link an existing artifact.                                |
| `fail_work(id, reason)`                                                                               | Set status to `failed` and store reason. Failed items are not auto-retried; retry is a fresh `enqueue_work` call. |
| `cancel_work(id, reason?)`                                                                            | Soft delete equivalent.                                                                                           |

**Artifacts:**

| Tool                                                                                | Purpose                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `attach_artifact(kind, title, body_markdown, work_item_id?, plan_id?, service_id?)` | Store a markdown artifact, optionally linked. |
| `get_artifact(id)`                                                                  | Fetch with body.                              |
| `list_artifacts(work_item_id?, plan_id?, service_id?, kind?)`                       | Filtered list (titles only).                  |

**Implementation note for `claim_next_work`:**

```sql
WITH next AS (
  SELECT id FROM work_items
  WHERE status = 'pending'
    AND ($1::work_type[] IS NULL OR type = ANY($1))
    AND ($2::int        IS NULL OR service_id = $2)
  ORDER BY priority DESC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE work_items w
   SET status = 'claimed', claimed_at = now(), claimed_by = $3, updated_at = now()
  FROM next
 WHERE w.id = next.id
RETURNING w.*;
```

## Slash Commands (Claude Code plugin)

Shipped in the same repo under `packages/claude-plugin/.claude/skills/`. Each is a thin skill that invokes one or more MCP tools.

| Command                                  | Wraps                                                               | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/sapling:work`                          | `claim_next_work` then loop into the appropriate type-specific flow | Pull next pending task and execute it in the current session |
| `/sapling:plan <desc>`                   | `enqueue_work(type='plan', ...)`                                    | Drop a planning task into the queue                          |
| `/sapling:enqueue <code\|review> <desc>` | `enqueue_work(...)`                                                 | Drop a code or review task                                   |
| `/sapling:status`                        | `list_work(status='pending')` + counts by status                    | Show queue health                                            |
| `/sapling:context <service>`             | `get_service` + `list_plans(service_id)` + recent artifacts         | Load full context for a service into the conversation        |

**Canonical `/sapling:work` flow:**

```
1. claim_next_work(claimed_by='claude-<host>')   ->  work_item or null
2. If plan task:
     - read description, list_services / get_service for context
     - draft plan
     - create_plan(...)                           ->  plan_id
     - enqueue_work(type='code', plan_id, ...)    ->  chain
     - complete_work(id, summary, artifact_id?)
   If code task:
     - get_plan(plan_id), get_service
     - work in the actual repo (filesystem, git)
     - attach_artifact(kind='draft_code', ...) for notable snippets
     - enqueue_work(type='review', branch, pr_url) when done
     - complete_work(id, summary)
   If review task:
     - read PR diff (filesystem/git)
     - attach_artifact(kind='review_notes', body)
     - complete_work(id, summary, artifact_id)
```

## Error Handling

- Every tool validates inputs with `zod` before touching the DB. Validation errors return `{ error: { code: 'invalid_input', message, issues[] } }`.
- DB errors mapped to stable codes:
  - `not_found` — FK target missing, `get_*` with bad id
  - `conflict` — e.g. duplicate `services.(app_id, name)`
  - `claim_race` — race lost on `claim_next_work`. Treated as "queue empty" (returns `null`), not an error.
  - `internal` — anything else; full stack logged server-side, generic message returned to agent.
- All writes wrapped in transactions. `claim_next_work` runs in a single tx using `FOR UPDATE SKIP LOCKED`.
- No retry logic in the server. Agents decide whether to retry.

## Testing

- **Unit tests** for `zod` schemas and pure helpers.
- **Integration tests** against real Postgres, spun up via `testcontainers` (or `docker-compose.test.yml`). Each test gets a fresh schema or transaction rollback.
- Coverage targets:
  - Each tool's happy path
  - FK violations -> `not_found`
  - Unique violations -> `conflict`
  - Concurrent `claim_next_work` from two clients -> exactly one wins, other gets `null`
  - Migration replay (apply same migration twice -> no-op via `_migrations` table)
- **No mocks of Postgres.** Too easy to drift from reality at this scale.
- Test command: `npm test` (Vitest) — runs unit, then integration if Docker is available.

## Migrations

On server startup:

1. Connect to DB, ensure `_migrations` table exists.
2. Scan `src/schema/*.sql` lexicographically.
3. For each file not in `_migrations`: run inside a transaction, then insert into `_migrations`.
4. Fail fast on any error.

~30 lines of TypeScript. No migration framework.

## Logging & Observability

- `pino` for structured JSON logs to stdout (captured via `docker compose logs`).
- Log every tool call: `{ tool, durationMs, ok, errorCode? }`. Inputs/outputs not logged by default; enable with `LOG_PAYLOADS=true`.
- Health endpoint: `GET /health` -> `{ ok: true, db: 'up'|'down' }`.

## Local Dev Workflow

```
make up         # docker compose up -d, runs migrations on container start
make logs       # docker compose logs -f mcp-server
make psql       # docker compose exec postgres psql -U sapling sapling
make test       # vitest
make down       # docker compose down (preserves data volume)
make nuke       # docker compose down -v (drops data — confirms first)
```

## Open Questions / Deferred

- **Backups.** Filesystem snapshot of `./data/postgres` only for v1. Add `pg_dump` on schedule when there's something worth losing.
- **Artifact size limits.** No hard cap in v1; rely on Postgres TOAST. Revisit if anything chokes.
- **Plan templates.** Could add a `plan_templates` table later if patterns emerge.
- **Work item cleanup.** Completed/cancelled rows never auto-purged. Add a retention policy if the table gets noisy.
