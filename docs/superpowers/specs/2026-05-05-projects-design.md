# Projects for Sapling — Design

**Status:** approved (brainstorm)
**Date:** 2026-05-05
**Related:** [Sapling MCP dev workbench design](2026-04-28-sapling-mcp-dev-workbench-design.md), [Agent Teams design](2026-04-29-agent-teams-design.md)

## Goal

Let a single intent — a Linear ticket, an idea, or a bug — drive itself to a verified definition of done across one or more services in an app. A **project** is the workflow driver: Sapling spawns the right child work items at the right time, gates completion behind explicit success criteria, and stays out of the runner's way.

## Concept

A **project** is a top-level row that owns the original intent (`title`, `description_md`, optional `linear_url`), an explicit `definition_of_done_md`, and a status. It groups N plans (one per affected service) and the code/review work items beneath them. The runner sees no new entity — it still claims `work_items`. Projects steer **what gets enqueued and when**, not **who runs it**.

```
app  ──┬──>  service  ──>  plan  ──>  work_item (code/review)
       │                     ▲
       │                     │
       └─────  project  ─────┘  (groups N plans across N services within one app)
```

The lifecycle is server-driven. Every status transition is a deterministic consequence of an explicit MCP tool call or a server-side hook on child work-item completion. No new daemon, no new runner loop, no new spawn mechanism.

## Non-goals

- **Cross-app projects.** A project is scoped to a single `app_id`. Spanning multiple apps is out of scope for v1.
- **Sapling-side outbound transports.** Linear updates are not made by the Sapling server. Projects with a `linear_url` get a binding-rule string injected into the agent's context at `/sapling:work` claim time, instructing the agent to use the Linear MCP it already has. Preserves SPEC §2's "no outbound transports" non-goal.
- **A new work_type.** The DoD verifier is a regular `review` work item with `is_dod_verifier = true`. No enum change to `work_type`.
- **Sealed scope.** Ad-hoc additions during a project are allowed (`enqueue_work` with `project_id`). Sapling does not enforce a "no scope creep" rule. Skills suggest spawning a child project for material scope shifts.
- **Workflow engine semantics.** Projects do not enforce per-step quality gates, role ordering, or rich state machines. The five states are derivable from child work-item state plus DoD verification.
- **Auto-retry of failed projects.** `retry_project` is explicit, used after a DoD verifier failure; failed underlying work items follow the existing `retry_work` semantics.

## Architecture

### Lifecycle

Five project statuses: `pending`, `scoping`, `in_progress`, `done`, `blocked`, `cancelled`. (`pending` exists only for the brief window between row insert and the first auto-enqueue inside the same transaction; in practice projects are observed in one of the other five.)

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
   cancel_project  ──> cancelled  (cascades cancel_work to non-terminal children)
```

### Decomposition: scope, then per-service plans, then code, then review

Two-phase by default, with a fast path for trivial work:

1. **Scoping phase.** `create_project` (without `service_ids`) auto-enqueues a single `plan`-type scoping work item. The agent claiming it explores the affected codebase, writes a `scoping`-kind artifact (freeform markdown summarizing which services are touched and what each needs), and calls `complete_scoping(project_id, service_ids[])`. That call is atomic: it validates each service id belongs to the project's app, fans out one `plan` work item per service (each with `project_id` set), and flips the project from `scoping` to `in_progress`. The agent then calls `complete_work` on the scoping work item itself.
2. **Per-service plan phase.** Each per-service plan work item is claimed by an agent that writes a regular plan (using the existing `create_plan` tool, with `project_id` set on the plan), enqueues code work items beneath it, and completes its own work item.
3. **Code phase.** Code work items execute as today.
4. **Per-plan review phase.** When the last code work item under a given plan completes, the server auto-enqueues one `review` work item linked to that plan and project. One review per service plan, not one review per code work item.
5. **DoD verification phase.** When all non-verifier work items under the project are completed, the server auto-enqueues one final `review` work item with `is_dod_verifier = true`, titled "Verify Definition of Done for project N: <title>." The verifier reads the project's `definition_of_done_md`, checks each criterion against shipped reality (PRs, tests, code), and either completes successfully → project flips to `done`, or completes with a `dod_gaps` artifact → project stays `in_progress` and a human/agent decides whether to enqueue more work.

The fast path: `create_project(service_ids=[...])` skips the scoping work item entirely. Project status starts at `in_progress`, plan work items fan out immediately. Use this for bugs and trivial features where the scope is already known.

### Definition of Done

`definition_of_done_md` is required at project creation. It is loaded into context for every child agent (scoping, plan-writers, coders, reviewers) so each one knows what success looks like. It also gates the `done` transition: the project does not reach `done` purely because all code/review children are completed — a final DoD verifier `review` must succeed against the criteria.

If the verifier fails, it writes a `dod_gaps` artifact listing which criteria were not satisfied. The project stays `in_progress`. The user can either enqueue additional work via `enqueue_work(project_id=...)` and then `retry_project` (which re-enqueues a fresh verifier), or accept and override by manually completing the verifier.

### Linear: pull on create, agent-side updates

- **Pull on create.** When `create_project` is called with a `linear_url`, the slash command (`/sapling:project create`) fetches the ticket via `mcp__linear-work__get_issue` and pre-fills `title` and `description_md` before calling `create_project`. The Sapling server itself never calls Linear.
- **Agent-side updates.** Every project work item claimed via `/sapling:work` has the project context (title, description, DoD) injected. If the project has a `linear_url`, an additional binding rule is appended:

  > _"This work item is part of project N (`<title>`), tracked at `<linear_url>`. When you complete this work item, post a brief comment on the Linear ticket summarizing what you did, using `mcp__linear-work__save_comment`. When the project transitions to `done`, the DoD verifier will post a final summary."_

  This is the entire two-way sync mechanism: one prompt-side instruction the agent obeys. No Sapling outbound transport.

### Cancellation, blocking, retry semantics

- **`cancel_project(id, reason?)`** — atomic and cascading. Sets project `cancelled`. Cascades `cancel_work` to all non-terminal child work items (`pending` / `claimed` / `awaiting_input` / `blocked`). Plans are not deleted (matches existing soft-delete semantics). Idempotent on already-cancelled.
- **`block_project(id, reason)`** — sets project `blocked` from `scoping` / `in_progress`. **Does not cascade**: in-flight children continue. Auto-enqueue triggers (post-scoping fan-out, per-plan review, DoD verifier) are paused while blocked.
- **`unblock_project(id)`** — recomputes target status from children: if a scoping child is still in-flight → `scoping`, otherwise → `in_progress`. Replays missed auto-enqueue triggers (e.g. a per-plan review whose code items completed during the blocked window).
- **`retry_project(id)`** — for a project that hit `done` but on inspection isn't actually done (rare). Status → `in_progress`, the existing DoD verifier is `retry_work`-ed.

### Ad-hoc additions

`enqueue_work` accepts an optional `project_id`. Adding a work item mid-project causes the DoD verifier to wait for it too before auto-enqueuing. Used by code agents adding follow-up code items, and by users adding ad-hoc work without spawning a sub-project. No enforced cap on additions; skills surface a soft suggestion to spawn a child project for material scope shifts.

## Data model

One new migration: `007_projects.sql`. New table, one new enum, two FK columns, one boolean.

```sql
CREATE TYPE project_status AS ENUM (
  'pending', 'scoping', 'in_progress', 'done', 'blocked', 'cancelled'
);

CREATE TABLE projects (
  id                     serial PRIMARY KEY,
  app_id                 int NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title                  text NOT NULL,
  description_md         text NOT NULL,
  definition_of_done_md  text NOT NULL,
  linear_url             text,
  status                 project_status NOT NULL DEFAULT 'pending',
  failure_reason         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans      ADD COLUMN project_id int REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE work_items ADD COLUMN project_id int REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE work_items ADD COLUMN is_dod_verifier boolean NOT NULL DEFAULT false;

CREATE INDEX plans_project_idx   ON plans(project_id)      WHERE project_id IS NOT NULL;
CREATE INDEX work_project_idx    ON work_items(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX projects_status_idx ON projects(status);
```

### Notes

- **`app_id` is `NOT NULL` and `ON DELETE CASCADE`.** Mirrors `services.app_id`. Deleting an app cascades through its services, projects, plans, and work items. Cross-app projects are forbidden by schema.
- **No new `work_type`.** The DoD verifier is a `review` row with `is_dod_verifier = true`. The server distinguishes it via that flag in one place: the auto-enqueue branch in `complete_work`.
- **No new artifact `kind` enum.** `kind` is free-form `TEXT` per SPEC §5. We adopt two new conventional kinds: `scoping` (the prose scope artifact written by the scoping agent) and `dod_gaps` (failure summary written by the DoD verifier).
- **All child FKs `ON DELETE SET NULL`.** Matches the existing pattern: deleting a project does not nuke history; orphan plans/work items survive with `project_id = NULL`.
- **No `team_id` on projects.** Each child work item resolves its team via existing `team_defaults` (per `app_id` × `work_type`). Project-level team selection is unnecessary at v1.
- **No `prior_status` column.** `unblock_project` recomputes target state from children, matching the simplicity of `unblock_work`.
- **`linear_url` is plain `TEXT`.** Agents parse the ticket id from the URL when needed.

## MCP tool surface

Adds **9 tools** in a new `tools/projects.ts` family. Brings SPEC §7 total from **40 → 49**.

| Tool                                                                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_project(app_name, title, description_md, definition_of_done_md, linear_url?, service_ids?)` | Atomic. Validates each `service_id` belongs to `app_name`. If `service_ids` is provided → status starts at `in_progress`, fans out one `plan` work item per service. Otherwise → status starts at `scoping`, auto-enqueues one `plan`-type scoping work item titled "Scope project N: <title>" with `project_id` set. Returns the created project plus any auto-enqueued work item. |
| `complete_scoping(project_id, service_ids[])`                                                       | Atomic. Called by the scoping agent after writing its `scoping` artifact. Validates project status is `scoping`. Validates each `service_id` belongs to the project's app. Enqueues one `plan` work item per service with `project_id` set. Flips project to `in_progress`. The agent's separate `complete_work` on the scoping work item is unaffected.                            |
| `get_project(id)`                                                                                   | Returns the project plus rolled-up child counts: `{ project, plan_count, work_counts: { pending, claimed, completed, ... }, scoping_artifact_id?, dod_verifier_id? }`.                                                                                                                                                                                                              |
| `list_projects(app_name?, status?)`                                                                 | Filtered list. Titles + counts only; no description or DoD bodies.                                                                                                                                                                                                                                                                                                                  |
| `update_project(id, title?, description_md?, definition_of_done_md?, linear_url?)`                  | Patch. `status` and `app_id` are not patchable — status changes go through lifecycle tools.                                                                                                                                                                                                                                                                                         |
| `cancel_project(id, reason?)`                                                                       | Atomic + cascading. Sets project `cancelled`. Cascades `cancel_work` to all non-terminal child work items. Idempotent on already-cancelled.                                                                                                                                                                                                                                         |
| `block_project(id, reason)`                                                                         | Sets project `blocked` from `scoping` / `in_progress`. Does not cascade. Auto-enqueue triggers paused while blocked. `failure_reason` records the reason.                                                                                                                                                                                                                           |
| `unblock_project(id)`                                                                               | Recomputes status (scoping if a scoping child is in-flight, else `in_progress`). Replays missed auto-enqueue triggers.                                                                                                                                                                                                                                                              |
| `retry_project(id)`                                                                                 | For a project that hit `done` but isn't actually done. Status → `in_progress`, existing DoD verifier `retry_work`-ed.                                                                                                                                                                                                                                                               |

### One existing-tool change

- **`enqueue_work`** accepts an optional `project_id`. Permits manual additions to a project mid-flight (used by both agents and humans).

### Server-side hooks (no MCP surface, documented in SPEC §8)

The new behavior concentrates in two places:

1. **`complete_scoping(...)`** — fans out per-service plan work items + flips project to `in_progress`. Already a tool.
2. **`complete_work(...)`** — gains a single `if (work.project_id)` branch calling `advanceProjectAfterWorkCompletion(projectId, completedWork)`. That helper does, in one transaction:
   - **completed code work item** → if every code work item under the same `plan_id` is completed, auto-enqueue one `review` work item with `project_id`, linked to that plan.
   - **completed review work item with `is_dod_verifier = false`** → if every non-verifier work item under the project is completed, auto-enqueue the DoD verifier (`review`, `is_dod_verifier = true`).
   - **completed review work item with `is_dod_verifier = true`** → flip project to `done`.

While project is `blocked`, the helper is a no-op; `unblock_project` re-runs it once to catch up.

## Slash-command surface

One new skill: `packages/claude-plugin/skills/project/SKILL.md`. Plugin version bumps **minor**: `0.5.0` → `0.6.0`.

| Slash command                                           | Wraps / does                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sapling:project create <app> <title>`                 | Interactive: prompts for `description_md`, `definition_of_done_md`, optional `linear_url`, optional `service_ids` (skip-scoping fast path). If a `linear <url>` token is provided, fetches the ticket via `mcp__linear-work__get_issue` and pre-fills `title` / `description_md` before calling `create_project`. |
| `/sapling:project list [<app>] [status <s>]`            | `list_projects` filtered. Renders title, app, status, child counts.                                                                                                                                                                                                                                               |
| `/sapling:project show <id>`                            | `get_project` plus the most recent `scoping` artifact and most recent `dod_gaps` artifact (if any). Loads project context into the conversation.                                                                                                                                                                  |
| `/sapling:project cancel <id> [<reason>]`               | `cancel_project`. Confirms cascade impact (count of in-flight children) before firing.                                                                                                                                                                                                                            |
| `/sapling:project block <id> <reason>` / `unblock <id>` | `block_project` / `unblock_project`.                                                                                                                                                                                                                                                                              |
| `/sapling:project retry <id>`                           | `retry_project`. Used after a DoD verifier failure once additional work has been enqueued.                                                                                                                                                                                                                        |

### Three integration points to existing slash commands

- **`/sapling:work`** — when claiming a work item with a `project_id`, prepends the project's `title`, `description_md`, and `definition_of_done_md` to the agent's operating instructions. Loads the most recent `scoping` artifact for the project. If `linear_url` is set, appends the Linear binding rule (see _Architecture › Linear_).
- **`/sapling:status`** — adds a Projects section above the existing work-queue counts: `<status> <count>` per project status, grouped by app. Single command answers both "what's the queue" and "what projects are in flight."
- **`/sapling:queue`** — gains `/sapling:queue project <id>` to drill into a project: lists all child plans + work items recursively.

## Error handling

Reuses the existing five codes from `errors.ts`. New cases:

| Code            | New cases                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input` | `service_ids` containing a service that doesn't belong to the project's `app_id`; `definition_of_done_md` empty; `complete_scoping` with empty `service_ids`.                     |
| `not_found`     | Project id lookups; `update_project` / `cancel_project` / `block_project` / `unblock_project` / `retry_project` for unknown id.                                                   |
| `conflict`      | `complete_scoping` on a project not in `scoping` status; `block_project` from terminal `done` / `cancelled`. `cancel_project` is idempotent (no `conflict` on already-cancelled). |
| `claim_race`    | Unchanged. Projects do not go through `claim_next_work`.                                                                                                                          |
| `internal`      | Unchanged.                                                                                                                                                                        |

## Testing

`packages/mcp-server/test/projects.test.ts`, vitest + testcontainers:

- **Happy path scoping flow.** `create_project` → claim+complete the scoping work item → `complete_scoping` fans out N plan work items → simulate code work items completing → per-plan review auto-enqueued and completed → all non-verifier complete → DoD verifier auto-enqueued → verifier completes → project = `done`.
- **Skip-scoping fast path.** `create_project(service_ids=[...])` → status = `in_progress`, no scoping work item, plan work items fanned out immediately.
- **DoD verifier failure.** Verifier completes with a `dod_gaps` artifact attached → project stays `in_progress`. `retry_project` re-enqueues a fresh verifier.
- **Cross-app rejection.** `create_project(app_name=X, service_ids=[Y belonging to app Z])` → `invalid_input`. Same for `complete_scoping`.
- **Cancel cascade.** `cancel_project` while children are mid-flight → all non-terminal children become `cancelled` in one transaction; terminal children untouched.
- **Block/unblock replay.** Block during `in_progress` while one plan still has open code items → complete the remaining code items while blocked → no review auto-enqueues fire → `unblock_project` → reviews auto-enqueue retroactively.
- **Ad-hoc enqueue.** `enqueue_work(project_id, type='code', ...)` mid-project → DoD verifier waits for it too before being auto-enqueued.
- **App delete cascade.** Delete an app with projects → projects cascade-deleted; their orphan child work items have `project_id = NULL` (FK on work_items is `ON DELETE SET NULL`, but the project rows are gone via the app cascade).
- **Migration replay.** Apply `007_projects.sql` twice → no-op via `_migrations`.

## SPEC.md updates (same commit/PR)

Per `CLAUDE.md`'s sync rule:

- **§2 Goals** — add a fifth: _"One verb to ship an intent. `/sapling:project create` takes an idea/ticket/bug and Sapling drives it to a verified Definition of Done."_
- **§2 Non-goals** — annotate the existing "no outbound transports" non-goal with a note that Linear updates are agent-side, preserving the invariant.
- **§4 Repo layout** — mention `packages/mcp-server/src/tools/projects.ts` and `packages/claude-plugin/skills/project/`.
- **§5 Data model** — add the `projects` table, `project_status` enum, FK columns on `plans` and `work_items`, `is_dod_verifier`, and the new indexes; extend the migration list with `007_projects.sql`.
- **§7 MCP tool surface** — total **40 → 49**; add a new "Projects" subsection covering the 9 tools; add `project_id?` to the `enqueue_work` signature.
- **§8 Work-item lifecycle** — add a sub-section "Project-driven auto-enqueue triggers" describing the two hook points (`complete_scoping`, `complete_work`), and a state diagram for the project lifecycle.
- **§12 Claude plugin** — add `/sapling:project` to the slash-command table; note `/sapling:status`, `/sapling:work`, `/sapling:queue` extensions.
- **§14 Error handling** — note the new error cases (no new codes).
- **§17 Reference: design documents** — append `2026-05-05-projects-design.md`.

## Plugin version

`packages/claude-plugin/.claude-plugin/plugin.json` bumps from current `0.5.0` to `0.6.0`. New skill plus binding-rule changes in `/sapling:work` are observable behavior shifts → minor bump per `CLAUDE.md`.

## Open questions

None at design time. The following are intentionally deferred:

- Per-project teams (use `team_defaults` for v1).
- Projects spanning multiple apps (forbidden by schema; revisit if a real cross-app initiative shows up).
- Auto-archival of completed projects (manual via `update_project` setting status, or none — projects are cheap rows).
- Linear sync beyond the agent-side comment-on-completion rule.
