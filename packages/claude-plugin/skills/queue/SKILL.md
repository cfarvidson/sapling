---
name: queue
description: Inspect and modify the Sapling queue — list pending work and non-archived plans, drill into a single work item or plan, and run lifecycle actions. Triggers on /sapling:queue.
---

# /sapling:queue

Surface and edit Sapling state. `list_work` / `list_plans` show metadata only — drill into a single id to see the body, then act on it.

## Forms

```
/sapling:queue                              — overview (active queue + open plans)
/sapling:queue work <id>                    — show one work item
/sapling:queue plan <id>                    — show one plan (full body)
/sapling:queue project <id>                 — drill into a project (children recursively)
/sapling:queue plan <id> activate              — draft → active
/sapling:queue plan <id> archive               — any → archived
/sapling:queue plan <id> update "<instruction>"
                                               — revise body/title from a free-form instruction
/sapling:queue plan <id> replace               — replace the body wholesale (asks for new body)
/sapling:queue work <id> cancel [<reason>]     — pending|claimed → cancelled
/sapling:queue work <id> block "<reason>"      — pending|claimed → blocked (skipped by claim_next_work)
/sapling:queue work <id> unblock               — blocked → pending
/sapling:queue work <id> retry                 — re-enqueue a copy of a failed/cancelled item
```

## Steps

### Overview (no args)

1. Call in parallel:
   - `mcp__sapling__list_work({ status: 'pending' })`
   - `mcp__sapling__list_work({ status: 'claimed' })`
   - `mcp__sapling__list_work({ status: 'blocked' })`
   - `mcp__sapling__list_work({ status: 'failed' })`
   - `mcp__sapling__list_plans({ status: 'draft' })`
   - `mcp__sapling__list_plans({ status: 'active' })`
2. Render five work sections + two plan sections, latest first; each row shows `#id` `type/status` `title` and (for work) `service_id` / `plan_id` / `claimed_by`:

```
PENDING WORK
  #4  review     IRIS-1636: …                  service=32 plan=1 team=code-review
  …
CLAIMED WORK         (in flight)
BLOCKED WORK         (with reason on its own line — waiting on external dependency)
FAILED WORK          (with failure_reason on its own line)
DRAFT PLANS          ← these need user sign-off; nothing will execute against them
ACTIVE PLANS
```

When a row's `team_name` is null (solo agent), suppress the `team=` key — show it only when set.

3. Footer: `Run /sapling:queue plan <id> activate` or `/sapling:queue work <id> unblock` so the next action is one keystroke away.

### `work <id>` / `plan <id>`

- `mcp__sapling__get_work({ id })` or `mcp__sapling__get_plan({ id })`.
- Print all fields. For plans, print `body_markdown` verbatim (in a fenced block).
- If `team_id` is set, also call `mcp__sapling__get_team({ id: team_id })` and print the team name, lead prompt header (first line), and role list. This makes it obvious what will run when the runner spawns this item.
- For work with a `plan_id`, also fetch that plan's status and warn if `draft` / `archived` / `completed` — those should not be executed against.

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

### Plan actions

- `activate`: `mcp__sapling__update_plan({ id, status: 'active' })`. Confirm the new status and offer: "Want me to enqueue a `code` work item for this plan?" — if yes, call `enqueue_work({ type: 'code', plan_id, service_id, title, description_markdown })` using a one-line title derived from the plan title.
- `archive`: `update_plan({ id, status: 'archived' })`. Warn if there are pending/claimed work items linked to it (`list_work({ plan_id: id })`) and offer to cancel them.
- `update "<instruction>"`: `mcp__sapling__get_plan({ id })`, apply the instruction to `body_markdown` and/or `title` in place (think "patch", not "rewrite"), show the diff, then `update_plan({ id, body_markdown, title? })` after confirmation. Status is unchanged unless the user asks.
- `replace`: ask the user for the new full `body_markdown` (and optional new title), confirm, then `update_plan`. Use this when the existing plan is fundamentally wrong rather than just out of date.

### Work actions

- `cancel`: `mcp__sapling__cancel_work({ id, reason })`. Refuse if `status` is already `completed` — surface why. After cancelling, run the plan roll-up nudge below.
- `block "<reason>"`: `mcp__sapling__block_work({ id, reason })`. Use when the item can't progress because of an external wait (PR review needed, missing answer from a stakeholder, blocked by another Sapling work item, infra not yet provisioned). Reason is required. `claim_next_work` will skip it.
- `unblock`: `mcp__sapling__unblock_work({ id })`. Flips `blocked → pending` and clears the reason. Refuse if the item isn't currently `blocked`.
- `retry`: only valid for `failed` or `cancelled`. Read the original via `get_work`, then `enqueue_work` with the same `type`, `title`, `description_markdown`, `service_id`, `plan_id`, `branch`, `pr_url`. Tell the user the new id. Don't reuse the old row.

### Plan roll-up nudge

After any work-item lifecycle change (cancel here; complete in `/sapling:work`), if the affected item had a `plan_id` and every sibling in `list_work({ plan_id })` is now `completed` or `cancelled` and the plan is still `active`, ask: "All work for plan #N is terminal. Mark the plan `completed`?" — on yes, `update_plan({ id: plan_id, status: 'completed' })`. Skip silently if any sibling is still pending/claimed/failed.

## Notes

- This skill never executes work. It only inspects state and flips lifecycle fields.
- For service-level deep dives (recent artifacts, conventions), prefer `/sapling:context <service>`.
- For raw counts only, `/sapling:status` is shorter.
- **Sapling ids and GitHub.** When `retry` copies a `title`/`description_markdown` forward, scrub any `#<n>` references to Sapling ids and rewrite as `Sapling work N` / `Sapling plan N`. GitHub auto-links `#N` to issues/PRs, which leaks broken cross-links if the new work item later turns into a PR. Same rule applies anywhere in `/sapling:work` — see that skill's "GitHub-bound text" section.
