# Sapling — Specification

> Authoritative, living specification for the Sapling repo. Update this in the same change as any code that alters the architecture, schema, MCP surface, work-item lifecycle, runner contract, plugin surface, or stated goals/non-goals. See [§ Maintenance rule](#16-maintenance-rule) at the end.

## Table of contents

1. [What Sapling is](#1-what-sapling-is)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Architecture](#3-architecture)
4. [Repo layout](#4-repo-layout)
5. [Data model](#5-data-model)
6. [MCP transport and auth](#6-mcp-transport-and-auth)
7. [MCP tool surface](#7-mcp-tool-surface)
8. [Work-item lifecycle](#8-work-item-lifecycle)
9. [Human-in-the-loop](#9-human-in-the-loop)
10. [Teams](#10-teams)
11. [Autonomous mode (sapling-runner)](#11-autonomous-mode-sapling-runner)
12. [Claude plugin](#12-claude-plugin)
13. [Configuration surface](#13-configuration-surface)
14. [Error handling, logging, observability](#14-error-handling-logging-observability)
15. [Migrations and testing](#15-migrations-and-testing)
16. [Maintenance rule](#16-maintenance-rule)
17. [Reference: design documents](#17-reference-design-documents)

---

## 1. What Sapling is

Sapling is an AI-native dev workbench: a Postgres-backed knowledge store and typed work queue exposed to coding agents (Claude Code first) via MCP. Sapling is the workbench, not the worker — agents pull tasks from Sapling and execute them in their own session/process. Real source code stays in the user's repos; Sapling stores plans, work items, artifacts, and product knowledge.

## 2. Goals and non-goals

### Goals

1. **One place for plans.** Every plan an agent generates lives in Postgres — queryable, linkable, statusable.
2. **One place for in-flight dev work.** Typed work items (`plan` / `code` / `review`) with cross-references so chains stay coherent.
3. **One place for product knowledge.** Apps and the services that compose them, with enough metadata for an agent to ground itself before acting.
4. **One verb to start work.** `/sapling:work` claims the next pending task and executes it in the current session.
5. **One verb to ship an intent.** `/sapling:project create` takes an idea / Linear ticket / bug and Sapling drives it across one or more services to a verified Definition of Done.

### Non-goals (v1)

- Web UI, REST API, standalone CLI.
- Multi-user; auth beyond an optional bearer token.
- Mirroring or storing repo source code (real code stays in git).
- Vector search / embeddings.
- Webhooks, event bus, metrics export. Discoverability is pull-based; opt-in operator-targeted notifications via the runner-side ntfy notifier are permitted as an attention mechanism for `awaiting_input` items, not as a general transport. Project-level Linear updates are emitted by agents through the Linear MCP they already have, not by the Sapling server — see [§ 12 Claude plugin](#12-claude-plugin).
- Automated backups (the bind-mounted `./data/postgres` volume is the recovery surface).
- A workflow engine. Sapling does not enforce role ordering or completion gates inside teams.
- A retry framework. Failed items are not auto-retried; retry is an explicit caller decision (`retry_work` or a fresh `enqueue_work`).

## 3. Architecture

Two services in `docker-compose.yml`. An optional third process (`sapling-runner`) lives in `packages/runner/` and is started with `make runner`.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  docker-compose.yml                                                          │
│                                                                              │
│  ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────┐  │
│  │ mcp-server          │─SQL│ postgres:16-alpine  │    │ ntfy             │  │
│  │ (Node 22 + TS, ESM) │ ─▶ │ volume ./data/pg    │    │ (loopback)       │  │
│  │ Express :3333 /mcp  │    │ port 5432 (loopback)│    │ port 8080        │  │
│  └──────────┬──────────┘    └─────────────────────┘    └─────────▲────────┘  │
└─────────────┼──────────────────────────────────────────────────── │ ─────────┘
              │                                                     │
              │ Streamable HTTP MCP (POST /mcp, SSE for tool stream)│ POST
              │ optional Authorization: Bearer <MCP_TOKEN>          │ (opt-in)
              ▼                                                     │
   ┌─────────────────────┐         ┌────────────────────┐           │
   │ Claude Code session │◀───────▶│ sapling-runner     │───────────┘
   │ (lead or solo agent)│  spawns │ (polling daemon)   │
   └─────────────────────┘         └────────────────────┘
```

### Key decisions

- **Single Node process** for the server. One user, local box, no clustering.
- **Stateful Streamable HTTP transport.** One MCP transport per session id; one new `McpServer` instance is built per session (`packages/mcp-server/src/server.ts`). This keeps tool registration deterministic and lets the SDK manage session lifecycle/SSE.
- **Migrations on startup.** Forward-only, idempotent, tracked in `_migrations`. Files in `packages/mcp-server/src/schema/NNN_*.sql`.
- **Bound to `127.0.0.1:3333`.** Not network-reachable. Postgres is bound to loopback as well.
- **Optional bearer auth** via `MCP_TOKEN`. Off by default. Applied only to `/mcp`; `/health` is always open.
- **Postgres** pinned to `postgres:16-alpine`; data persisted to `./data/postgres` (gitignored). Postgres 15+ syntax (`UNIQUE NULLS NOT DISTINCT`) is in use.
- **No outbound transports.** Discoverability is pull-based (`/sapling:human`, `/sapling:status`).
- **Atomic claim** via `FOR UPDATE SKIP LOCKED`. Race losers get `null`, treated as "queue empty," not an error.
- **Self-hosted ntfy** as a third compose service (loopback by default). The runner POSTs to it on stale `awaiting_input` items when `runner_config.ntfy_url` is set. Operator chooses an exposure path (Tailscale recommended, LAN, or Cloudflare Tunnel) — see README.

## 4. Repo layout

```
sapling/
  docker-compose.yml
  Makefile                      # up / down / logs / psql / test / nuke / build / runner
  package.json                  # workspace root
  pnpm-workspace.yaml
  .env.example
  README.md
  SPEC.md                       # this file
  CLAUDE.md                     # instructs Claude to keep SPEC.md in sync

  packages/
    mcp-server/                 # Node/TS MCP server
      src/
        index.ts                # bootstrap (HTTP listen + migrate)
        server.ts               # createApp(): Express + transport plumbing + bearer auth
        db.ts                   # pg pool factory
        migrate.ts              # startup migrator (~30 LOC)
        config.ts               # env parsing
        errors.ts               # AppError + pg → AppError mapping
        logger.ts               # pino instance
        schema/                 # NNN_*.sql, applied lexicographically
        tools/                  # one file per tool family + register.ts entrypoint
          projects.ts           # all 9 project tools + advanceProjectAfterWorkCompletion helper
      test/                     # vitest + testcontainers
      Dockerfile
    runner/                     # sapling-runner: polling daemon
      src/
        index.ts                # CLI args, signals, tick interval
        loop.ts                 # tick(): reap → read config → spawn up to max_concurrent
        spawn.ts                # bash -lc <agent_command>
        mcp_client.ts           # thin HTTP MCP client (calls reap_stuck_claims, list_work, get_runner_config)
      test/
    claude-plugin/              # MCP wiring + slash-command skills
      .mcp.json                 # default Claude Code MCP config (http://localhost:3333/mcp)
      skills/                   # context, enqueue, human, learn, plan, project, queue, rules, status, teams, work
      README.md

  .claude-plugin/
    marketplace.json            # marketplace entry installed via `/plugin marketplace add cfarvidson/sapling`

  docs/superpowers/
    specs/                      # design documents (historical record of decisions)
    plans/                      # prior implementation plans

  data/postgres/                # bind-mounted postgres volume (gitignored)
```

## 5. Data model

Authoritative source: `packages/mcp-server/src/schema/*.sql`. The migrations applied so far are:

| File                            | Effect                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_init.sql`                  | Initial schema: `apps`, `services`, `plans`, `work_items`, `artifacts`, `_migrations`; enums.                                                                                    |
| `002_app_conventions.sql`       | Adds `apps.conventions TEXT`.                                                                                                                                                    |
| `003_work_blocked.sql`          | Adds `'blocked'` to the `work_status` enum.                                                                                                                                      |
| `004_runner_groundwork.sql`     | Adds `attempt_count`, `next_retry_at`, `claim_expires_at` to `work_items`; creates `runner_config`.                                                                              |
| `005_awaiting_input_status.sql` | Adds `'awaiting_input'` to the `work_status` enum.                                                                                                                               |
| `006_teams.sql`                 | Creates `teams`, `team_roles`, `team_defaults`; adds `work_items.team_id`.                                                                                                       |
| `007_projects.sql`              | Creates `projects`, `project_status` enum, `project_id` FKs on `plans` and `work_items`, `is_dod_verifier` flag on `work_items`.                                                 |
| `008_depends_on_work_id.sql`    | Adds `work_items.depends_on_work_id` (self-FK, `ON DELETE SET NULL`) and a partial index.                                                                                        |
| `010_runner_ntfy_config.sql`    | Adds `ntfy_url` (TEXT, nullable), `awaiting_input_nag_age_ms` (INT NOT NULL DEFAULT 3600000), `awaiting_input_nag_repeat_ms` (INT NOT NULL DEFAULT 21600000) to `runner_config`. |

### Tables

- **`apps`** — top-level products. `(name)` unique. Carries optional `description`, `conventions`.
- **`services`** — components of an app. `(app_id, name)` unique; `app_id → apps.id ON DELETE CASCADE`. Carries `repo_url`, `description`, `tech_stack TEXT[]`, `depends_on TEXT[]` (service names, not ids), `conventions`.
- **`plans`** — markdown plan documents. `parent_plan_id → plans.id ON DELETE SET NULL`, `service_id → services.id ON DELETE SET NULL`. Indexed by `service_id` and `status`.
- **`work_items`** — the queue. Detailed below.
- **`projects`** — top-level intents. `app_id → apps.id ON DELETE CASCADE` (NOT NULL — projects are scoped to one app). Carries `title`, `description_md`, `definition_of_done_md`, optional `linear_url`, `status` (see enum), `failure_reason`. See [§ 7](#7-mcp-tool-surface) and [§ 8](#8-work-item-lifecycle) for behavior.
- **`artifacts`** — markdown blobs (review notes, pending questions, answers, architecture summaries, drafts). Optional FKs to `work_item_id`, `plan_id`, `service_id` — all `ON DELETE SET NULL`. Free-form `kind TEXT`. Multiple artifacts of the same kind per parent are allowed.
- **`teams` / `team_roles` / `team_defaults`** — see [§ Teams](#10-teams).
- **`runner_config`** — singleton (`PRIMARY KEY DEFAULT 1 CHECK (id = 1)`). See [§ Configuration surface](#13-configuration-surface).
- **`_migrations`** — `(filename PRIMARY KEY, applied_at)`.

### Enums

```sql
plan_status    = 'draft' | 'active' | 'completed' | 'archived'
work_type      = 'plan'  | 'code'   | 'review'
work_status    = 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled'
               | 'blocked' | 'awaiting_input'
project_status = 'pending' | 'scoping' | 'in_progress' | 'done' | 'blocked' | 'cancelled'
```

### `work_items` columns

```
id                   serial PK
type                 work_type           -- plan | code | review
status               work_status         -- default 'pending'
title                text
description_markdown text
priority             int                 -- default 0; higher first
service_id           int  → services    ON DELETE SET NULL
plan_id              int  → plans       ON DELETE SET NULL
team_id              int  → teams       ON DELETE SET NULL  (006)
project_id           int  → projects   ON DELETE SET NULL   (007)
is_dod_verifier      boolean default false                   (007)
depends_on_work_id   int  → work_items  ON DELETE SET NULL  (008)
branch               text
pr_url               text
claimed_at           timestamptz
claimed_by           text
completed_at         timestamptz
failure_reason       text
attempt_count        int  default 0      (004)
next_retry_at        timestamptz         (004)
claim_expires_at     timestamptz         (004)
created_at           timestamptz default now()
updated_at           timestamptz default now()
```

### Indexing strategy

- `work_pending_idx` — partial index `(priority DESC, created_at ASC) WHERE status = 'pending'`. Keeps `claim_next_work` O(log N) regardless of completed-task volume.
- `work_status_idx` — broad status filter.
- `work_claim_expiry_idx` — partial index `(claim_expires_at) WHERE status = 'claimed'`. Used by `reap_stuck_claims`.
- `work_team_idx` — partial index `(team_id) WHERE team_id IS NOT NULL`.
- `work_depends_on_idx` — partial index `(depends_on_work_id) WHERE depends_on_work_id IS NOT NULL`. Keeps the dep-status filter in `claim_next_work` cheap.
- `plans_service_idx`, `plans_status_idx`, `artifacts_work_idx`, `artifacts_plan_idx`.
- `plans_project_idx` — partial index on `plans(project_id)` where `project_id IS NOT NULL`.
- `work_project_idx` — partial index on `work_items(project_id)` where `project_id IS NOT NULL`.
- `projects_status_idx` — broad project status filter.

### FK convention

All FKs are `ON DELETE SET NULL` except `services.app_id` (CASCADE) and intra-team rows (`team_roles.team_id`, `team_defaults.team_id` CASCADE; `team_defaults.app_id` CASCADE). Deleting a plan, team, or service must not nuke work history; deleting an app does cascade through services and team-app scoping.

`projects.app_id` is `ON DELETE CASCADE` and `NOT NULL` (mirrors `services.app_id`); deleting an app cascades through services and projects. Plans and work items hold `project_id` as `ON DELETE SET NULL` so deleting a project preserves history.

## 6. MCP transport and auth

- **Transport:** Streamable HTTP. Single endpoint `POST /mcp`. Session id is carried in the `Mcp-Session-Id` header; one transport instance per session is held in an in-memory map. Initialize requests without a session id create a new transport; subsequent requests reuse it. Closing the transport removes the session.
- **CORS:** open (`origin: '*'`) with `WWW-Authenticate`, `Mcp-Session-Id`, `Mcp-Protocol-Version` exposed. Practical because the server is bound to loopback.
- **Health endpoint:** `GET /health` → `{ ok: true, db: 'up' }` or `503 { ok: false, db: 'down' }` based on a `SELECT 1`. Always open (no auth).
- **Auth:** if `MCP_TOKEN` is set, all requests under `/mcp` require `Authorization: Bearer <MCP_TOKEN>` and return `401 unauthorized` otherwise. `/health` is unaffected.

## 7. MCP tool surface

**Total: 49 tools.** Authoritative source: `packages/mcp-server/src/tools/`. Tools are registered via `registerAllTools` in `tools/register.ts`. Every call is instrumented with structured `tool_call` log lines (`{ tool, durationMs, ok }`).

All inputs validated with `zod`. All success responses are JSON in a `text` content block. Errors return `{ error: { code, message, issues? } }` with `isError: true` (see [§ Error handling](#14-error-handling-logging-observability)).

### Apps & services (`tools/products.ts`) — 8 tools

| Tool                                               | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `register_app(name, description?, conventions?)`   | Create an app. Unique by `name`.                             |
| `update_app(id, ...partial)`                       | Patch any scalar.                                            |
| `list_apps()`                                      | All apps.                                                    |
| `get_app(id_or_name)`                              | Full detail.                                                 |
| `register_service(app_name, name, repo_url?, ...)` | Create a service. Unique by `(app_id, name)`.                |
| `update_service(id, ...partial)`                   | Patch any field.                                             |
| `list_services(app_name?)`                         | Filter optional.                                             |
| `get_service(id_or_name)`                          | Full detail incl. `tech_stack`, `depends_on`, `conventions`. |

### Plans (`tools/plans.ts`) — 4 tools

| Tool                                                                                           | Purpose                                                                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `create_plan(title, body_markdown, service_id?, parent_plan_id?, project_id?, status='draft')` | Store a plan. `project_id` links the plan to a project (per-service plan under a multi-service project). |
| `get_plan(id)`                                                                                 | Fetch with body.                                                                                         |
| `list_plans(service_id?, project_id?, status?)`                                                | Filtered list (titles only, no bodies).                                                                  |
| `update_plan(id, ...partial)`                                                                  | Patch title/body/status/links (incl. `project_id`).                                                      |

### Work queue (`tools/work.ts`) — 11 tools

| Tool                                                                                                                                              | Purpose                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueue_work(type, title, description_markdown, priority?, service_id?, plan_id?, branch?, pr_url?, team_id?, project_id?, depends_on_work_id?)` | Add a task. Resolves `team_id` from defaults at insert time (see [§ Teams](#10-teams)). Optional `depends_on_work_id` chains the new item behind an upstream item — `claim_next_work` skips it until the upstream is `completed`.                                                                                              |
| `claim_next_work(claimed_by, types?, service_id?, app_id?, app_name?)`                                                                            | **Atomic.** `FOR UPDATE SKIP LOCKED`. Skips items with future `next_retry_at`, items past the attempt cap, and items whose `depends_on_work_id` upstream is not `completed`. Returns next pending item or `null`. Sets `status='claimed'`, `claimed_at`, `claimed_by`, `claim_expires_at`, and **increments `attempt_count`**. |
| `get_work(id)`                                                                                                                                    | Fetch one.                                                                                                                                                                                                                                                                                                                     |
| `list_work(status?, type?, service_id?, plan_id?, app_id?, app_name?, depends_on_work_id?)`                                                       | Filtered list. Joins `teams` to surface `team_name`. Filter by `depends_on_work_id` to find dependents of an upstream item.                                                                                                                                                                                                    |
| `complete_work(id, summary_markdown?, artifact_id?)`                                                                                              | Mark `completed`. Optional summary stored as artifact, or link an existing artifact.                                                                                                                                                                                                                                           |
| `fail_work(id, reason)`                                                                                                                           | Set `failed`. Failed items are not auto-retried.                                                                                                                                                                                                                                                                               |
| `cancel_work(id, reason?)`                                                                                                                        | Soft delete equivalent.                                                                                                                                                                                                                                                                                                        |
| `block_work(id, reason)`                                                                                                                          | Set `blocked` from `pending` / `claimed` / `blocked` / `failed`. Reason stored in `failure_reason` (terminal `completed` / `cancelled` items rejected with `conflict`).                                                                                                                                                        |
| `unblock_work(id)`                                                                                                                                | `blocked → pending` only.                                                                                                                                                                                                                                                                                                      |
| `retry_work(id, after_ms?)`                                                                                                                       | Re-queue from `failed` / `blocked` / `claimed` / `awaiting_input` to `pending`. Optional `after_ms` schedules `next_retry_at`. **Does not mutate `attempt_count`** — explicit retries are clean retries.                                                                                                                       |
| `reap_stuck_claims(now?)`                                                                                                                         | Sweep `claimed` items past `claim_expires_at`: → `failed` if `attempt_count >= max_claim_attempts`, else → `pending`. Does not bump `attempt_count` (claim already did). Called by the runner each tick.                                                                                                                       |

### Artifacts (`tools/artifacts.ts`) — 3 tools

| Tool                                                                                | Purpose                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `attach_artifact(kind, title, body_markdown, work_item_id?, plan_id?, service_id?)` | Store a markdown artifact, optionally linked. |
| `get_artifact(id)`                                                                  | Fetch with body.                              |
| `list_artifacts(work_item_id?, plan_id?, service_id?, kind?)`                       | Filtered list.                                |

### Runner config (`tools/runner_config.ts`) — 2 tools

| Tool                                                                                                                                                                                     | Purpose                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `get_runner_config()`                                                                                                                                                                    | Read the singleton config row.                                      |
| `update_runner_config({ agent_command?, max_concurrent?, poll_interval_ms?, claim_ttl_ms?, max_claim_attempts?, ntfy_url?, awaiting_input_nag_age_ms?, awaiting_input_nag_repeat_ms? })` | Partial upsert. `ntfy_url` accepts `null` to disable notifications. |

### Human-in-the-loop (`tools/human_input.ts`) — 2 tools

| Tool                                               | Purpose                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `request_human_input(work_id, questions_markdown)` | Atomic: writes a `pending_questions` artifact and flips `claimed → awaiting_input`. Caller must currently hold the claim. |
| `provide_human_input(work_id, answers_markdown)`   | Atomic: writes an `answers` artifact and flips `awaiting_input → pending`. The next runner tick re-claims the item.       |

### Teams (`tools/teams.ts`) — 10 tools

| Tool                                                                     | Purpose                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------ |
| `create_team(name, lead_prompt_md, app_id?, description?, roles?[])`     | Create a team and its initial roles in one call.                                             |
| `update_team(id, ...partial)`                                            | Patch team scalars.                                                                          |
| `delete_team(id)`                                                        | Hard delete. Cascades to `team_roles` and `team_defaults`; `work_items.team_id` set to NULL. |
| `list_teams(app_id?, app_name?)`                                         | Optional scope filter. Returns teams + role counts.                                          |
| `get_team({ id }                                                         | { name, app_id? })`                                                                          | Returns a team plus its roles. |
| `add_team_role(team_id, name, description_md, subagent_type?, ordinal?)` | Add a single role.                                                                           |
| `update_team_role(id, ...partial)`                                       | Patch a role.                                                                                |
| `remove_team_role(id)`                                                   | Delete a role.                                                                               |
| `set_team_default(work_type, team_id, app_id?)`                          | Upsert `(app_id?, work_type) → team_id`.                                                     |
| `clear_team_default(work_type, app_id?)`                                 | Remove a default.                                                                            |

> The `enqueue_work` signature accepts an optional `project_id`; when set, the work item participates in project auto-enqueue triggers (see [§ 8](#8-work-item-lifecycle)).

### Projects (`tools/projects.ts`) — 9 tools

| Tool                                                                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_project(app_name, title, description_md, definition_of_done_md, linear_url?, service_ids?)` | Atomic. Validates each `service_id` belongs to `app_name`. If `service_ids` provided → status starts at `in_progress`, fans out one `plan` work item per service. Otherwise → status starts at `scoping`, auto-enqueues one `plan`-type scoping work item titled "Scope project N: <title>" with `project_id` set. Returns the created project plus any auto-enqueued work item.                    |
| `complete_scoping(project_id, service_ids[])`                                                       | Atomic. Called by the scoping agent after writing its `scoping` artifact. Validates project status is `scoping`. Validates each `service_id` belongs to the project's app. Enqueues one `plan` work item per service with `project_id` set. Flips project to `in_progress`.                                                                                                                         |
| `get_project(id)`                                                                                   | Returns the project plus rolled-up child counts: `{ project, plan_count, work_counts: { pending, claimed, completed, ... }, scoping_artifact_id?, dod_verifier_id? }`.                                                                                                                                                                                                                              |
| `list_projects(app_name?, status?)`                                                                 | Filtered list. Titles + counts only; no description or DoD bodies.                                                                                                                                                                                                                                                                                                                                  |
| `update_project(id, title?, description_md?, definition_of_done_md?, linear_url?)`                  | Patch. `status` and `app_id` are not patchable — status changes go through lifecycle tools.                                                                                                                                                                                                                                                                                                         |
| `cancel_project(id, reason?)`                                                                       | Atomic + cascading. Sets project `cancelled`. Cascades `cancel_work` to all non-terminal child work items. Idempotent on already-cancelled.                                                                                                                                                                                                                                                         |
| `block_project(id, reason)`                                                                         | Sets project `blocked` from `scoping` / `in_progress`. **Cascades**: child work items in `pending` or `awaiting_input` are flipped to `blocked` with `failure_reason = 'project blocked: <reason>'` (the reserved prefix marks cascade-blocked rows). `claimed` children are not touched — Sapling cannot kill the agent process. Returns `{ project, cascade_blocked_count }`.                     |
| `unblock_project(id)`                                                                               | Recomputes status (`scoping` if a scoping child is in-flight, else `in_progress`). **Cascade-unblocks** children whose `failure_reason` starts with the reserved prefix `'project blocked: '`. Replays `advanceProjectAfterWorkCompletion` for **every** completed non-verifier child in `completed_at` order (helper guards make this idempotent). Returns `{ project, cascade_unblocked_count }`. |
| `retry_project(id)`                                                                                 | For a project that hit `done` but isn't actually done. Status → `in_progress`, existing DoD verifier `retry_work`-ed.                                                                                                                                                                                                                                                                               |

> The `'project blocked: '` prefix on `failure_reason` is reserved. Operators must not use it in `block_work` reason text, or the row will be swept by `unblock_project`'s cascade-unblock.

## 8. Work-item lifecycle

```
                    enqueue_work
                         │
                         ▼
                    ┌──────────┐
       retry_work ──│ pending  │── claim_next_work ──► ┌──────────┐
            ▲       └──────────┘                       │ claimed  │
            │            ▲                             └─────┬────┘
            │            │                                   │
            │   provide_human_input                          ├── complete_work ──► completed
            │            │                                   │
            │            │                                   ├── fail_work ──────► failed ── retry_work ──┐
            │            │                                   │                                            │
            │            │                                   ├── cancel_work ────► cancelled              │
            │            │                                   │                                            │
            │            │                                   ├── block_work ─────► blocked ──unblock_work─┤
            │            │                                   │                                            │
            │            │                                   ├── request_human_input ──► awaiting_input ──┤
            │            │                                   │                                            │
            │            │                                   └── (claim expired) ──► reap_stuck_claims ───┤
            │            │                                                              │                 │
            │            │                                                              ├──► pending ─────┤
            │            │                                                              │                 │
            │            │                                                              └──► failed ──────┘
            │            │
            └──────── pending ◄────────────────────────────────────────────────────────────────────────────┘
```

### Claim atomicity

`claim_next_work` reads `runner_config` (for `max_claim_attempts` and `claim_ttl_ms`) and updates the row in one statement. Filters out items past their `next_retry_at`, items past the attempt cap, items whose upstream dep is not yet `completed`, and rows locked by a concurrent claimer (`SKIP LOCKED`).

```sql
WITH cfg AS (
  SELECT max_claim_attempts, claim_ttl_ms FROM runner_config WHERE id = 1
),
next AS (
  SELECT w.id FROM work_items w
   LEFT JOIN services s ON s.id = w.service_id
   LEFT JOIN work_items dep ON dep.id = w.depends_on_work_id
   WHERE w.status = 'pending'
     AND ($1::work_type[] IS NULL OR w.type = ANY($1))
     AND ($2::int IS NULL OR w.service_id = $2)
     AND ($3::int IS NULL OR s.app_id = $3)
     AND (w.next_retry_at IS NULL OR w.next_retry_at <= now())
     AND w.attempt_count < (SELECT max_claim_attempts FROM cfg)
     AND (w.depends_on_work_id IS NULL OR dep.status = 'completed')
   ORDER BY w.priority DESC, w.created_at ASC
   FOR UPDATE OF w SKIP LOCKED
   LIMIT 1
)
UPDATE work_items w
   SET status = 'claimed',
       claimed_at = now(),
       claimed_by = $4,
       claim_expires_at = now() + ((SELECT claim_ttl_ms FROM cfg) || ' milliseconds')::interval,
       attempt_count = w.attempt_count + 1,
       updated_at = now()
  FROM next
 WHERE w.id = next.id
RETURNING w.*;
```

Parameters: `$1` types[], `$2` service_id, `$3` resolved app_id (from `app_id` or `app_name`), `$4` claimed_by. Race losers get `null`, returned as `null` (not an error). Callers treat as "queue empty."

### Reaper

Each runner tick calls `reap_stuck_claims(now?)` (the optional `now` is for testability; production passes nothing and the server uses `now()`). For each `claimed` row past `claim_expires_at`:

- If `attempt_count >= max_claim_attempts` → set `status = 'failed'`, `failure_reason = 'reaped after N attempts; last claimed_by=X'`.
- Else → set `status = 'pending'`.

In both cases `claimed_at`, `claimed_by`, `claim_expires_at` are cleared. **The reaper does not bump `attempt_count`** — `claim_next_work` already incremented it when the now-stuck claim was made. Returns the affected rows (`{ id, status, attempt_count, prior_claimed_by }`) sorted by id.

### Failure semantics

- **`failed`** is terminal until an explicit `retry_work` (or a fresh `enqueue_work`).
- **`cancelled`** is terminal; `retry_work` does **not** re-open `cancelled` (only `failed` / `blocked` / `claimed` / `awaiting_input`).
- **`blocked`** is non-terminal; only `unblock_work` clears it back to `pending`. Used when an item depends on something outside Sapling.
- **`retry_work`** is a clean retry: clears `failure_reason`, `claimed_*`, `claim_expires_at`; sets `next_retry_at` if `after_ms` was passed; does **not** mutate `attempt_count`. Combined with `claim_next_work`'s attempt-cap filter, this means an operator who wants to give a stuck item a fresh budget should retry **and** also reset `attempt_count` directly via psql (no MCP tool exposes this — by design).

### Project-driven auto-enqueue triggers

Projects steer what gets enqueued and when. The logic concentrates in two tool implementations:

1. **`complete_scoping(project_id, service_ids[])`** — fans out one `plan` work item per service with `project_id` set, then flips the project from `scoping` to `in_progress`. The scoping agent's separate `complete_work` on its own work item is unaffected.
2. **`complete_work(id, ...)`** — if the completed item has a `project_id`, calls `advanceProjectAfterWorkCompletion(client, projectId, completedWork)` inside the same transaction. That helper fires these checks in order:
   - **DoD-verifier completed** (`is_dod_verifier = true`) → flip project to `done`.
   - **Per-plan review** — if the completed item is `code` and every code work item under the same `plan_id` is now completed, auto-enqueue one `review` work item with `project_id` linked to that plan.
   - **DoD verifier** — if the completed item is a non-verifier `review` and every non-verifier work item under the project is now completed, auto-enqueue one final `review` with `is_dod_verifier = true`, titled "Verify Definition of Done for project N: \<title\>."
   - **Blocked projects** — while a project is `blocked`, the helper is a no-op; `unblock_project` re-runs it once to catch up on any triggers that fired during the blocked window.

**Project lifecycle state diagram:**

```
                   create_project
                         │
                         ▼
   ┌── (service_ids passed) ──> in_progress ──┐
   │                                          │
   ▼                                          │
scoping ── complete_scoping ──────────────────┤
   │                                          │
   ▼                                          ▼
   └─────────── all child plans done ──> auto-enqueue DoD verifier
                                                   │
                                                   ▼
                                        [verifier completes]
                                                   │
                                  ┌────────────────┼────────────────┐
                                  ▼                                 ▼
                                done                       stays in_progress
                                                          (writes dod_gaps artifact)

   block_project   ──> blocked  ── unblock_project ──> (recomputed prior state)
                          │                           + cascade-unblock children
                          │                           + replay all completions
                          │  cascades to pending +
                          │  awaiting_input children
                          │  (claimed left alone)
   cancel_project  ──> cancelled  (cascades cancel_work to non-terminal children)
```

### Dependencies (`depends_on_work_id`)

`enqueue_work` accepts an optional `depends_on_work_id` that pins the new item behind an upstream work item. The model is intentionally minimal:

- A single nullable self-FK column on `work_items` (`ON DELETE SET NULL`). No new status, no triggers, no event bus.
- `claim_next_work` joins `work_items dep ON dep.id = w.depends_on_work_id` and gates eligibility on `dep.status = 'completed'`. Items whose dep is `pending` / `claimed` / `awaiting_input` / `blocked` simply stay unclaimable until the upstream flips to `completed`. Items whose dep is `failed` / `cancelled` likewise stay unclaimable — the operator can `cancel_work` the dependent or change the upstream's status.
- Deleting the upstream nulls out `depends_on_work_id` and unblocks the dependent (mirroring the FK convention: deleting history must not strand work).
- Validation at `enqueue_work` time: the upstream must exist, and if both items are scoped to apps, the apps must match. Self-reference and cycles are unreachable on insert (the new row's id does not exist yet) so no extra check is needed.
- `block_work` / `unblock_work` are unchanged. Use `block_work` for external dependencies that aren't a Sapling work item; use `depends_on_work_id` for the natural review→fix chain inside Sapling.

## 9. Human-in-the-loop

Discoverability is **pull-based**. There are no outbound notifiers.

When an autonomous agent hits an ambiguity that would require guessing — unspecified API shape, missing acceptance criteria, two reasonable approaches — it pauses the work item instead of producing a half-baked plan:

1. Agent calls `request_human_input(work_id, questions_markdown)`.
2. Server atomically writes a `pending_questions` artifact and flips `claimed → awaiting_input`.
3. Runner skips `awaiting_input` items, so the queue keeps moving.
4. User runs `/sapling:human` to list paused items, or `/sapling:human <id>` to answer in-session.
5. `/sapling:human` calls `provide_human_input(work_id, answers_markdown)`. Server writes an `answers` artifact and flips `awaiting_input → pending`.
6. Next runner tick re-claims the item. The fresh agent reads both artifacts (latest `pending_questions` + newer `answers`) before continuing.

`/sapling:status` shows the `awaiting_input` count alongside the others. `/sapling:queue work <id> retry` clears a paused item if the questions turn out to be wrong.

## 10. Teams

A **team** lets one work item be executed by a coordinated **lead + specialists** instead of a solo agent. The runner spawns the lead (one OS process). The lead dispatches specialists in-process via Claude Code's `Agent` tool. Solo execution remains the default.

### Tables (recap)

```sql
CREATE TABLE teams (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  app_id         int REFERENCES apps(id) ON DELETE CASCADE,  -- null = global
  description    text,
  lead_prompt_md text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (app_id, name)
);

CREATE TABLE team_roles (
  id             serial PRIMARY KEY,
  team_id        int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description_md text NOT NULL,
  subagent_type  text,            -- optional pin; null => general-purpose
  ordinal        int NOT NULL DEFAULT 0,
  UNIQUE (team_id, name)
);

CREATE TABLE team_defaults (
  id        serial PRIMARY KEY,
  app_id    int REFERENCES apps(id) ON DELETE CASCADE,
  work_type work_type NOT NULL,
  team_id   int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT team_defaults_uniq UNIQUE NULLS NOT DISTINCT (app_id, work_type)
);

ALTER TABLE work_items ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
```

### Resolution at enqueue time

`enqueue_work` resolves `team_id` once, at insert. Order:

1. If the caller passes `team_id`, validate scope (`teams.app_id` must be `NULL` or equal to the work item's service's `app_id`) and use it.
2. Else look up `team_defaults` by `(work_item.service.app_id, work_item.type)`.
3. Else look up `team_defaults` by `(NULL, work_item.type)`.
4. Else leave `team_id = NULL` → solo agent.

The resolved value is stored explicitly on the row. Changing a default later does **not** retroactively reroute pending items.

### Lead mode

When `/sapling:work` claims an item with `team_id`:

- Calls `get_team({ id: team_id })`.
- Prepends `lead_prompt_md` to its operating instructions for this item.
- Treats roles as **available specialists**: each role's `description_md` is the prompt context, `subagent_type` (if set) is the Claude Code subagent identifier; otherwise `general-purpose`.
- Dispatches specialists via the `Agent` tool when the work demands it. The lead has agent judgment about when/how/whom.
- Remains the **sole writer**: filesystem changes, commits, artifacts, and `complete_work` all run on the lead. Specialists return text only.
- Mentions which specialists were dispatched in the `summary_markdown` passed to `complete_work`.

### Invariants

- **One team = one runner slot.** `max_concurrent` semantics are unchanged. A team that fans out five specialists is still one process.
- **Specialists inherit the lead's worktree.** No per-specialist worktrees, no concurrent-write conflicts.
- **Specialists have no Sapling identity.** They cannot pause, claim, or fail Sapling work. Only the lead can call `request_human_input`.
- **Deleting a team is non-destructive.** `work_items.team_id` is `ON DELETE SET NULL`; referencing items revert to solo execution rather than failing the delete.
- **No new runner code path.** Teams are entirely a server-side + skill concern.

## 11. Autonomous mode (sapling-runner)

`packages/runner/` is a thin polling daemon. It is not part of `docker-compose.yml`; start it with `make runner` (foreground; `SIGINT`/`SIGTERM` for graceful shutdown).

### Tick algorithm (`packages/runner/src/loop.ts`)

```
1. reap = await mcp.reapStuckClaims()
2. cfg = await mcp.getRunnerConfig()
3. pending = await mcp.listPendingWork()
4. available = max(0, cfg.max_concurrent - running.size)
5. toSpawn = min(available, pending.length)
6. for i in 0..toSpawn:
     child = bash -lc <cfg.agent_command>
     running.add(child); on exit: running.delete(child)
7. emit { reaped, spawned, pending, running }
8. if cfg.ntfy_url is set:
     awaiting = await mcp.listAwaitingInput()
     for each item with age >= awaiting_input_nag_age_ms
         and not nagged within awaiting_input_nag_repeat_ms:
       POST to cfg.ntfy_url; record lastNotifiedAt[id]
     log 'awaiting_input' { count, oldest_age_ms, nagged }
```

Each spawned agent self-claims via `claim_next_work`. The runner does not pre-allocate items to processes; if `pending` shrinks before the spawned agent calls `claim_next_work`, the agent simply gets `null` and exits.

The notifier's per-item last-notified state is in-memory only — a runner restart re-nags each still-stale item once. Acceptable for v1; can be promoted to a `work_items.notified_at` column later if double-pings become noisy.

### CLI flags

- `--once` — one tick then exit. Waits up to `SHUTDOWN_GRACE_MS` (30 s) for in-flight children.
- `--max-spawn <N>` — stop spawning after N total spawns; then graceful shutdown.

### Environment

| Variable                  | Default                     | Notes                                                    |
| ------------------------- | --------------------------- | -------------------------------------------------------- |
| `SAPLING_MCP_URL`         | `http://127.0.0.1:3333/mcp` | Streamable HTTP MCP endpoint.                            |
| `MCP_TOKEN`               | (none)                      | Optional bearer for `/mcp`.                              |
| `SAPLING_RUNNER_LOG_FILE` | `./data/runner.log`         | JSON event log path. Empty string disables file logging. |

### Runtime config (in `runner_config`, mutable via `update_runner_config`)

- `agent_command` — applied on the next tick.
- `max_concurrent` — applied on the next tick.
- `poll_interval_ms` — read **once at startup** to arm the polling timer; restart required to apply.
- `claim_ttl_ms` — used by the reaper. Defaults to `7200000` (2 h).
- `max_claim_attempts` — defaults to `5`.
- `ntfy_url` — optional ntfy topic URL for `awaiting_input` notifications. `NULL` disables notifications.
- `awaiting_input_nag_age_ms` — minimum age before an `awaiting_input` item is nagged. Defaults to `3600000` (1 h).
- `awaiting_input_nag_repeat_ms` — minimum interval between repeat nags for the same item. Defaults to `21600000` (6 h).

### Logging

The runner writes every event as a JSON line to the file at `SAPLING_RUNNER_LOG_FILE` (default `./data/runner.log`; empty string disables). The parent directory is created on demand. Stdout is filtered for human reading: `start`, `spawned`, `reaped`, `tick_error`, `shutdown`, `max_spawn_reached`, and `done` always print; idle ticks (`reaped == 0 && spawned == 0`) are suppressed; an `alive — running=N pending=N` heartbeat prints every 20th idle tick.

When a tick reports `awaiting_input` count > 0, the runner emits an `awaiting_input` event line on stdout (formatted as `⚠ awaiting_input count=N oldest=Xh nagged=N`) regardless of idle status. The event is also written to the JSON file log.

### Shutdown

`SIGINT`/`SIGTERM` → stop the polling timer, wait up to 30 s for children to exit, `SIGKILL` survivors, close MCP client, `process.exit(0)`.

## 12. Claude plugin

`packages/claude-plugin/` ships:

- `.mcp.json` template wiring `sapling` to `http://localhost:3333/mcp`.
- Slash-command skills under `skills/`. Each is a thin skill that invokes one or more MCP tools.

| Slash command                                                           | Wraps / does                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sapling:work`                                                         | `claim_next_work`, then branches on `type` and `team_id` (lead mode if set). Executes in the current Claude session.                                                                                                                                                                                                                    |
| `/sapling:plan <desc>`                                                  | `enqueue_work(type='plan', ...)`.                                                                                                                                                                                                                                                                                                       |
| `/sapling:enqueue <code\|review> <desc>`                                | `enqueue_work(...)`. Both `enqueue` and `plan` accept an optional `team <name>` token.                                                                                                                                                                                                                                                  |
| `/sapling:status`                                                       | `list_work` + counts by status (`pending` / `claimed` / `awaiting_input` / `blocked` / `failed`).                                                                                                                                                                                                                                       |
| `/sapling:human [<id>]`                                                 | List `awaiting_input` items, or fetch `pending_questions` and submit `provide_human_input(answers)` in-session.                                                                                                                                                                                                                         |
| `/sapling:queue [<work\|plan> <id> [action]]`                           | Inspect queue or run lifecycle actions (activate, archive, update, replace, cancel, block, unblock, retry).                                                                                                                                                                                                                             |
| `/sapling:rules [<service>\|app <app>] [add\|replace\|remove\|clear …]` | Manage binding rules attached to an app or service.                                                                                                                                                                                                                                                                                     |
| `/sapling:context <service>`                                            | `get_service` + `list_plans(service_id)` + recent artifacts → loaded into the conversation.                                                                                                                                                                                                                                             |
| `/sapling:learn <app> [<path1> ...]`                                    | Research local repos for an app; populates services, dependencies, and an `architecture` artifact. See the design doc.                                                                                                                                                                                                                  |
| `/sapling:teams`                                                        | CRUD for teams (mirrors `/sapling:rules`).                                                                                                                                                                                                                                                                                              |
| `/sapling:project [<args>]`                                             | CRUD for projects (`create_project`, `complete_scoping` is invoked by `/sapling:work`-claimed scoping items, `cancel_project`, `block_project`, `unblock_project`, `retry_project`). Pull-on-create from Linear via `mcp__linear-work__get_issue`; agent-side comments back to Linear via the binding rule injected by `/sapling:work`. |

Three existing skills are extended by the projects feature: **`/sapling:work`** prepends the project's `title`, `description_md`, and `definition_of_done_md` to the agent's operating instructions when the claimed item has a `project_id`, and appends a Linear binding rule if `linear_url` is set. **`/sapling:status`** adds a Projects section above the work-queue counts, grouped by app and status. **`/sapling:queue`** gains `/sapling:queue project <id>` to drill into a project's child plans and work items recursively.

Marketplace entry lives at `.claude-plugin/marketplace.json` and is installed via `/plugin marketplace add cfarvidson/sapling` then `/plugin install sapling@sapling`.

## 13. Configuration surface

| Setting                                                                 | Where                    | Default                                                     | Notes                                                    |
| ----------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                                                          | `mcp-server` env         | `postgres://sapling:changeme-locally@postgres:5432/sapling` | Set by `docker-compose.yml`.                             |
| `SAPLING_PORT`                                                          | `mcp-server` env         | `3333`                                                      | Bound to `127.0.0.1`.                                    |
| `MCP_TOKEN`                                                             | `.env` (server + runner) | (none)                                                      | Optional bearer auth on `/mcp`.                          |
| `LOG_LEVEL`                                                             | `mcp-server` env         | `info`                                                      | pino level.                                              |
| `LOG_PAYLOADS`                                                          | `mcp-server` env         | `false`                                                     | When `true`, log tool inputs and outputs (verbose).      |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | `.env`                   | `sapling` / `changeme-locally` / `sapling` / `5432`         | Used by the postgres service and `make psql`.            |
| `SAPLING_MCP_URL`                                                       | runner env               | `http://127.0.0.1:3333/mcp`                                 | Where the runner reaches the MCP server.                 |
| `SAPLING_RUNNER_LOG_FILE`                                               | runner env               | `./data/runner.log`                                         | JSON event log path. Empty string disables file logging. |
| `agent_command`                                                         | `runner_config` table    | `claude --dangerously-skip-permissions -p "/sapling:work"`  | Spawned per slot via `bash -lc`. Applies on next tick.   |
| `max_concurrent`                                                        | `runner_config` table    | `2`                                                         | Applies on next tick.                                    |
| `poll_interval_ms`                                                      | `runner_config` table    | `30000`                                                     | Read once at startup; restart required.                  |
| `claim_ttl_ms`                                                          | `runner_config` table    | `7200000` (2 h)                                             | Used by `reap_stuck_claims`.                             |
| `max_claim_attempts`                                                    | `runner_config` table    | `5`                                                         | After this many reaps the item moves to `failed`.        |
| `ntfy_url`                                                              | `runner_config` table    | `NULL`                                                      | ntfy topic URL for `awaiting_input` notifications.       |
| `awaiting_input_nag_age_ms`                                             | `runner_config` table    | `3600000` (1 h)                                             | Minimum age before nagging.                              |
| `awaiting_input_nag_repeat_ms`                                          | `runner_config` table    | `21600000` (6 h)                                            | Minimum interval between repeat nags.                    |

## 14. Error handling, logging, observability

### Error shape

Every tool returns either `{ content: [{ type: 'text', text: <json> }] }` on success or `{ content: [...], isError: true }` with `{ error: { code, message, issues? } }` on failure.

Error codes (`packages/mcp-server/src/errors.ts`):

| Code            | Meaning                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input` | `zod` validation failure or domain-level invalid input (e.g. team scoped to wrong app). For projects: `service_ids` containing a service that doesn't belong to the project's `app_id`; empty `definition_of_done_md`; `complete_scoping` called with empty `service_ids`. |
| `not_found`     | Lookup by id/name returned nothing, or FK target missing (`23503`). For projects: unknown project id in `get_project`, `update_project`, `cancel_project`, `block_project`, `unblock_project`, or `retry_project`.                                                         |
| `conflict`      | Unique constraint violation (`23505`). For projects: `complete_scoping` on a project not in `scoping` status; `block_project` from terminal `done` / `cancelled`. `cancel_project` is idempotent — no `conflict` on already-cancelled.                                     |
| `claim_race`    | `claim_next_work` race lost. **Returned as `null`, not as an error**, per design. Projects do not go through `claim_next_work`.                                                                                                                                            |
| `internal`      | Anything else. Full stack logged server-side; generic message returned to caller.                                                                                                                                                                                          |

### Logging

- **`pino`** structured JSON to stdout.
- Every tool call is wrapped: `tool_call { tool, durationMs, ok }` (and `tool_call_threw` for uncaught throws).
- Inputs/outputs are not logged by default; enable with `LOG_PAYLOADS=true`.

### Observability

- Health endpoint: `GET /health`.
- `make logs` tails the mcp-server container.
- The runner emits one structured line per tick: `tick { reaped, spawned, pending, running }`.

## 15. Migrations and testing

### Migrations

On server startup (`packages/mcp-server/src/migrate.ts`):

1. Connect to DB, ensure `_migrations` table exists.
2. Scan `src/schema/*.sql` lexicographically.
3. For each file not in `_migrations`: run inside a transaction, then insert into `_migrations`.
4. Fail fast on any error. ~30 lines of TypeScript; no migration framework.

To re-run on an already-built image, `docker compose restart mcp-server` is enough.

### Testing

- **Vitest** for both packages.
- **testcontainers** spins up a real Postgres for integration tests. Docker must be running locally.
- No mocks of Postgres at this scale.
- Coverage targets:
  - Each tool's happy path.
  - FK violations → `not_found`.
  - Unique violations → `conflict`.
  - Concurrent `claim_next_work` from two clients → exactly one wins, other gets `null`.
  - Migration replay (apply same migration twice → no-op via `_migrations`).
  - `enqueue_work` team-resolution chain (explicit > per-app default > global default > null).
  - Team-delete cascade behavior (`work_items.team_id` set to NULL).
- Test command: `make test` (runs `mcp-server` then `runner` test suites).

## 16. Maintenance rule

SPEC.md is part of the code, not documentation maintained by someone else. **Update it in the same change as any of the following:**

- Add, remove, or rename an MCP tool (and update the **Total: N tools** count and the per-family tables in [§ 7](#7-mcp-tool-surface)).
- Add, remove, or rename a slash command in `packages/claude-plugin/skills/` ([§ 12](#12-claude-plugin)).
- Change the data model: new migration in `packages/mcp-server/src/schema/`, new enum value, new table, new column with semantic meaning ([§ 5](#5-data-model)).
- Change the work-item lifecycle: new status, new transition, new reaper behavior ([§ 8](#8-work-item-lifecycle)).
- Change runtime topology: new process, new port, new transport, new container ([§ 3](#3-architecture), [§ 6](#6-mcp-transport-and-auth)).
- Change runner config keys, defaults, or the tick algorithm ([§ 11](#11-autonomous-mode-sapling-runner), [§ 13](#13-configuration-surface)).
- Change a stated goal or non-goal ([§ 2](#2-goals-and-non-goals)).
- Change error codes, the error response shape, or the auth model ([§ 6](#6-mcp-transport-and-auth), [§ 14](#14-error-handling-logging-observability)).

If unsure whether a change qualifies, update SPEC.md. Over-updating costs nothing; drift costs trust.

Pure refactors, formatting, dependency bumps that don't alter behavior, and test-only changes do **not** require a SPEC.md update.

When SPEC.md and a dated design doc in `docs/superpowers/specs/` disagree, **SPEC.md wins for the current shape of the system**; the design doc remains the historical record of why a decision was made.

## 17. Reference: design documents

The dated specs in `docs/superpowers/specs/` are the source rationale for the decisions above. Refer to them when "why" matters; trust SPEC.md when "what" matters.

- `2026-04-28-sapling-mcp-dev-workbench-design.md` — original workbench design (architecture, initial schema, tool families, error model).
- `2026-04-28-sapling-learn-design.md` — `/sapling:learn` design (detection rules, merge semantics on re-run, architecture-artifact format).
- `2026-04-29-agent-teams-design.md` — teams design (lead-as-coordinator pattern, resolve-at-enqueue, ON DELETE SET NULL rationale, rejected alternatives).
- `2026-05-05-projects-design.md` — projects design (workflow-driven intent objects: scoping → per-service plans → code → per-plan reviews → DoD verifier).
