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
