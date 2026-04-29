# Agent Teams for Sapling Work — Design

**Status:** approved (brainstorm)
**Date:** 2026-04-29
**Related:** [Sapling MCP dev workbench design](2026-04-28-sapling-mcp-dev-workbench-design.md)

## Goal

Let a Sapling work item be executed by a coordinated **team** of specialized agents (lead + specialists) instead of a single solo agent. The lead is what the runner spawns; specialists are dispatched in-process via Claude Code's `Agent` tool. Solo execution remains the default and unchanged.

## Concept

A **team** is a named bundle of role definitions, optionally scoped to an app. A work item carries an optional `team_id`. When the runner spawns `/sapling:work` for an item with `team_id`, the agent enters **lead mode**: it loads the team, prepends the team's lead prompt to its operating instructions, and uses the role list to dispatch specialists via the `Agent` tool as the work demands. Specialists are invisible to Sapling — they live and die inside the lead's process. Items without `team_id` run exactly as today.

This is purely an in-process coordination pattern. The runner does not learn about teams; `max_concurrent` semantics are unchanged (one team = one slot).

## Non-goals

- **Not a workflow engine.** Sapling does not enforce role ordering, mandatory invocations, or completion gates per role. The lead has agent judgment about when to invoke whom.
- **Not parallelism across work items.** A team operates on one work item. Multi-item parallelism is still controlled by `max_concurrent`.
- **Not per-specialist observability.** Specialist outputs surface only via the lead's `summary_markdown` (or, optionally, artifacts the lead attaches). Sapling does not track individual specialist runs.
- **Not a new spawn mechanism.** No new runner code path, no per-team `agent_command`, no separate `/sapling:team-work` skill.

## Architecture

### Data model

Two new tables, one new column on `work_items`.

```sql
CREATE TABLE teams (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  app_id         int REFERENCES apps(id) ON DELETE CASCADE,  -- null = global
  description    text,
  lead_prompt_md text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (app_id, name)  -- PG 15+; Sapling pins postgres:16-alpine
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
  app_id     int REFERENCES apps(id) ON DELETE CASCADE,  -- null = global default
  work_type  work_type NOT NULL,                         -- enum: 'plan' | 'code' | 'review'
  team_id    int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, work_type)
);

ALTER TABLE work_items
  ADD COLUMN team_id int REFERENCES teams(id) ON DELETE SET NULL;
```

Notes:

- `teams.app_id` nullable — `null` means a global team usable by any app or by items without a service.
- `(app_id, name)` unique with `NULLS NOT DISTINCT` so two global teams cannot share a name (Postgres default treats NULLs as distinct, which would silently allow duplicates). The same team name can still coexist globally and per app — `(NULL, 'code-review')` and `(5, 'code-review')` are different rows.
- `team_roles.subagent_type` stores the fully qualified Claude Code subagent identifier (e.g. `compound-engineering:review:security-reviewer`) when the user wants to pin a role; otherwise the lead defaults to `general-purpose`.
- `team_defaults` is keyed on `(app_id, work_type)` so each (app, type) pair has at most one default; `app_id = NULL` is the global fallback.
- `work_items.team_id` is `ON DELETE SET NULL` — deleting a team causes referencing items to revert to solo execution rather than failing the delete or cascading the delete to work history.

### Resolution at enqueue time

`enqueue_work` resolves `team_id` once, at insert. Order:

1. If the caller passes `team_id`, use it.
2. Else look up `team_defaults` by `(work_item.service.app_id, work_item.type)`.
3. Else look up `team_defaults` by `(NULL, work_item.type)`.
4. Else leave `team_id = NULL` → solo agent.

Stored explicitly on the row, so a later default change does not retroactively reroute pending items. If the caller passes `team_id` for a team scoped to a different app, `enqueue_work` rejects with `invalid_input`.

### MCP tools (additions)

Ten new tools, all following the shape of existing CRUD tools (zod schemas, `errorToToolResult`, JSON content responses):

| Tool                 | Purpose                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `create_team`        | Create a team and its initial roles in one call.                                             |
| `update_team`        | Patch team scalars (`name`, `description`, `lead_prompt_md`, `app_id`).                      |
| `list_teams`         | Optional `app_id` / `app_name` filter. Returns teams + role counts.                          |
| `get_team`           | Returns a team plus its roles. Lookup by `id` or `(name, app_id?)`.                          |
| `delete_team`        | Hard delete. Cascades to `team_roles` and `team_defaults`; `work_items.team_id` set to NULL. |
| `add_team_role`      | Add a single role to an existing team.                                                       |
| `update_team_role`   | Patch a role.                                                                                |
| `remove_team_role`   | Delete a role.                                                                               |
| `set_team_default`   | Upsert `(app_id?, work_type) → team_id`.                                                     |
| `clear_team_default` | Remove a default.                                                                            |

`enqueue_work` gains an optional `team_id` parameter. `list_work` gains a left join to `teams` so each row carries `team_name` (mirroring how `app_id` / `app_name` are returned today).

That brings Sapling from 26 → 36 tools.

### Skill changes

**New skill: `/sapling:teams`** — CRUD for teams, mirroring `/sapling:rules`:

```
/sapling:teams                              # list all teams (grouped by app)
/sapling:teams show <name> [app <app>]      # full team + roles
/sapling:teams create <name> [app <app>]    # interactive: collect lead_prompt + roles
/sapling:teams add-role <team> <role>       # interactive: collect description, subagent_type
/sapling:teams set-default <work_type> <team> [app <app>]
/sapling:teams clear-default <work_type> [app <app>]
/sapling:teams remove <team>
```

**Modified skill: `/sapling:work`** — insert step 4b after "Load binding rules":

> **Step 4b. Load team (if assigned).** If the claimed work item has `team_id`, call `get_team({ id: team_id })`. Treat the response as **lead mode**:
>
> - Prepend `lead_prompt_md` to your operating instructions for this item.
> - You have these specialists available: `<roles list: name + description_md + subagent_type>`.
> - Dispatch them via the `Agent` tool when the work demands it. Use the role's `description_md` as prompt context. Use `subagent_type` if pinned, otherwise `general-purpose`.
> - You remain responsible for filesystem changes, commits, artifacts, and `complete_work`. Specialists return text to you; you decide what lands.
> - Mention which specialists you dispatched in the `summary_markdown` you pass to `complete_work`.
>
> If `team_id` is null, proceed in solo mode (current behavior, unchanged).

**Modified skills: `/sapling:enqueue` and `/sapling:plan`** — both accept an optional `team <name>` token. When present, pass `team_id` (resolved to the matching team) to `enqueue_work`. Without it, the server-side default lookup applies.

**No change to:** the runner package, `request_human_input` semantics, worktree creation rules, `claim_next_work` (atomic claim is opaque to teams).

### Workspace

Lead operates in the worktree exactly as today's `/sapling:work` flow prescribes (validated branch name, `<repo_root>/.worktrees/<sanitized-tail>` path, `cwd` assertion before subprocesses). Specialists dispatched via the `Agent` tool inherit the parent process's filesystem context — no per-specialist worktrees. The lead is the only writer; specialists return text. This keeps "one work item = one branch" intact and avoids concurrent-write conflicts between specialists.

### Observability

- `/sapling:status` and `/sapling:queue` display `team_name` on each item (free from the `list_work` join).
- The lead's `summary_markdown` (passed to `complete_work`) is the canonical record of which specialists were used. The lead-mode prompt makes this a soft convention.
- Specialist work that warrants persistent surfacing (review notes, draft artifacts) can be promoted to artifacts via the existing `attach_artifact` tool — no new mechanism. Sapling does not track individual specialist invocations.

### `awaiting_input` and human-in-the-loop

Unchanged from today. The lead pauses the whole team by calling `request_human_input` exactly as a solo agent would; specialists have no Sapling identity and cannot pause independently (they can only return text to the lead, who decides whether to escalate). When the user answers via `/sapling:human`, the work item flips back to `pending`; the next runner tick spawns a fresh lead that re-reads `team_id`, re-loads the team definition, and continues with the answers in hand.

### `max_concurrent` and runner

Unchanged. One team = one slot. A team that fans out five specialists is still one process. Teams are a coordination pattern, not a parallelism multiplier. The runner remains a dumb spawner with no awareness of teams.

### Backwards compatibility

`team_id` is nullable; `null` means solo. Existing work items, runner config, skills, and tests keep working untouched. The migration is additive — two new tables, one nullable column, no data backfill required.

## Decisions and rationale

| Decision                                                                                                           | Why                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Teams stored in Postgres, not hardcoded recipes.**                                                               | Consistent with how every other configurable thing in Sapling works (apps/services conventions, runner_config, rules). Hardcoded defaults would be the only piece of config that doesn't follow Sapling's "data-driven, MCP-managed" pattern. YAGNI on shipping defaults — the user invents the first 2-3 teams while dogfooding. |
| **Lead-as-coordinator inside one process (Claude `Agent` tool), not separate Sapling work items per specialist.**  | Reuses Claude's existing subagent ecosystem. Keeps `max_concurrent` semantically meaningful. Avoids inventing a Sapling-side coordination protocol that Claude already provides. Leaves the runner unchanged.                                                                                                                     |
| **Minimal role schema (name + prose description + optional subagent_type) rather than structured workflow rules.** | Gives `/sapling:teams` something concrete to display and edit, but the lead retains agent judgment about when/how to invoke specialists. Avoids turning Sapling into a half-baked workflow engine. Mirrors how `app.conventions` / `service.conventions` are prose-with-just-enough-structure.                                    |
| **Explicit `team_id` on the work item, populated at enqueue time from defaults.**                                  | A work item's "what will run this" is answerable by looking at the row alone — no hidden resolution at claim time, no risk of pending items getting rerouted by a later default change. Same explicit-state-over-computed-state principle Sapling already uses.                                                                   |
| **`/sapling:work` switches modes; runner is unchanged.**                                                           | Runner stays a dumb spawner (already a virtue). Teams become entirely a server-side + skill concern. `/sapling:work` already branches on `type`; adding a `team_id` branch is the same shape.                                                                                                                                     |
| **Specialists inherit lead's worktree; lead is the only writer.**                                                  | One branch per work item, no concurrent-write conflicts, no per-specialist worktree management. Specialists return text; lead decides what lands.                                                                                                                                                                                 |
| **`work_items.team_id` is `ON DELETE SET NULL`.**                                                                  | Deleting a team should not require deleting work history or block on referencing items. Items revert to solo agent — the safe, additive default.                                                                                                                                                                                  |

## Rejected alternatives

- **Hardcoded team recipes per work-type.** Inconsistent with Sapling's data-driven config; would force code edits + redeploys to add a team. Rejected during Q2.
- **Multiple specialists running in parallel as separate Sapling work items.** Explodes the queue, forces Sapling to invent a coordination protocol Claude already has, breaks `max_concurrent` semantics. Rejected during Q3.
- **Per-team `agent_command` on the runner.** Forces the runner to peek at the next item's `team_id` before spawning, breaking `claim_next_work`'s atomic-and-opaque contract. Rejected during Q6.
- **Per-team lead skill (`/sapling:team-<name>`).** Skill files explode 1:1 with teams; duplicates `/sapling:work` logic. Rejected during Q6.
- **Compute team at claim time from defaults.** Pending items rerouted by later default changes — confusing failure mode. Rejected during Q5 in favor of resolve-at-enqueue.
- **`ON DELETE RESTRICT` for `work_items.team_id`.** Would require manually rerouting every historical item before deleting a team — high friction for a low-stakes operation.

## Open questions

None at this time. Implementation can proceed.

## Implementation outline (for the planning step)

1. **Schema migration.** Add `teams`, `team_roles`, `team_defaults` tables; add `work_items.team_id` column. Forward-only, idempotent, follows existing `_migrations` pattern.
2. **MCP tools.** Add the 9 team tools in a new `packages/mcp-server/src/tools/teams.ts`. Extend `enqueue_work` to accept `team_id` and apply the default-resolution chain. Extend `list_work`'s join to surface `team_name`.
3. **Skill: `/sapling:teams`.** Mirror the structure of `/sapling:rules`.
4. **Skill: `/sapling:work`.** Insert step 4b. Define the lead-mode prompt template.
5. **Skill: `/sapling:enqueue` and `/sapling:plan`.** Add the `team <name>` token parser.
6. **Skill: `/sapling:status` and `/sapling:queue`.** Surface `team_name` next to each item.
7. **Tests.** Tool-level tests in `packages/mcp-server/test/` (testcontainers Postgres). Resolution-chain tests for `enqueue_work`. Cascade-behavior tests for team delete.
8. **Docs.** Update README tool count (26 → 36). Add a "Teams" section explaining lead/specialist mental model.
