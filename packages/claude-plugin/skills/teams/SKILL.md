---
name: teams
description: Manage agent teams in Sapling — create teams, manage roles, set per-(app, work_type) defaults that auto-attach a team to new work items. Triggers on /sapling:teams.
---

# /sapling:teams

A **team** is a named bundle of role definitions. When attached to a work item (via `team_id`), `/sapling:work` switches into "lead mode": the agent that the runner spawns prepends the team's `lead_prompt_md` to its instructions and dispatches specialists via Claude's `Agent` tool when the work demands it. Items without a team run as solo agents (current behavior).

Teams are stored server-side. They have an optional `app_id` so you can have global teams (`app_id = NULL`) and per-app overrides with the same name.

## Forms

```
/sapling:teams                                      — list every team, grouped by app
/sapling:teams <name> [app <app>]                   — show one team + its roles + lead prompt
/sapling:teams create <name> [app <app>]            — interactive: collect lead prompt + initial roles
/sapling:teams update <name> [app <app>]            — interactive: edit description / lead prompt / app scope
/sapling:teams remove <name> [app <app>]            — delete the team (work items revert to solo)

/sapling:teams <name> [app <app>] add-role <role>   — interactive: collect description, optional subagent_type
/sapling:teams <name> [app <app>] update-role <role>— interactive: edit description / subagent_type / ordinal
/sapling:teams <name> [app <app>] remove-role <role>— delete one role

/sapling:teams set-default <work_type> <team> [app <app>]
                                                    — auto-attach <team> to new <work_type> items in that scope
/sapling:teams clear-default <work_type> [app <app>]
                                                    — remove a default
```

`<work_type>` is one of `plan`, `code`, `review`.

## Steps

### Overview (no args)

1. `mcp__sapling__list_teams({})` — returns every team plus `role_count`.
2. Group by `app_id` (treat NULL as `(global)`). Sort apps alphabetically; `(global)` first. For each group:

   ```
   GLOBAL TEAMS
     code-review        (id 3)  3 roles
     plan-board         (id 5)  4 roles
   APP TEAMS — iris
     code-review        (id 7)  4 roles  ← shadows global "code-review" for iris items
   ```

3. Below the list, render the **defaults** by querying `mcp__sapling__list_teams` and joining against the `team_defaults` table is not exposed as a tool — instead, infer defaults by attempting `get_team` lookups isn't necessary either. Skip the defaults summary in the overview; users can see the active default for an item from `/sapling:queue work <id>` (which shows `team_name`). Footer:

   ```
   Run /sapling:teams <name> to inspect, or /sapling:teams create <name> to add a new one.
   ```

### Show one (`<name> [app <app>]`)

1. Resolve `app_id`:
   - If `app <app>` is present, `mcp__sapling__get_app({ name: <app> })` → `app.id`.
   - Else `app_id = null` (global).
2. `mcp__sapling__get_team({ name, app_id })`. If `not_found`, tell the user there is no `<name>` team in that scope and suggest `create`.
3. Print:

   ```
   ## <name>            (id <id>, app=<app or global>)
   <description (or "—")>

   LEAD PROMPT
   <lead_prompt_md>

   ROLES (in dispatch-list order)
     - <role.name>   subagent_type=<role.subagent_type or general-purpose>
       <role.description_md>
   ```

### Create (`create <name> [app <app>]`)

1. Resolve `app_id` as above.
2. Ask the user (in chat) for:
   - `description` (one-liner, optional)
   - `lead_prompt_md` (multi-line markdown — what should the lead emphasize? what's the team's posture?)
   - `roles`: collect at least one. For each, ask for `name`, `description_md` (when to invoke this specialist + what to prompt them with), and optionally `subagent_type` (a fully qualified Claude Code subagent identifier; leave blank for `general-purpose`).
3. Confirm the full body back to the user, then call `mcp__sapling__create_team({ name, app_id, description, lead_prompt_md, roles })`.
4. Tell the user the new id and offer: "Want me to set this as the default team for `<work_type>` items? (`/sapling:teams set-default …`)"

### Update (`update <name> [app <app>]`)

1. `get_team` to load current state. Print the current values.
2. Ask which fields to change. Call `mcp__sapling__update_team({ id, ...patch })` with only the changed fields.
3. Confirm with the new full body.

### Remove (`remove <name> [app <app>]`)

1. `get_team` first to confirm it exists. Look up referencing work items: `mcp__sapling__list_work({})` and filter by `team_name`. If any non-terminal items reference it, list them and ask "These will revert to solo agent. Continue?" before proceeding.
2. `mcp__sapling__delete_team({ id })`. Confirm.

### Role actions

- `add-role <role>`: `mcp__sapling__add_team_role({ team_id, name, description_md, subagent_type?, ordinal? })`. Ask the user for description, optional subagent_type, and ordinal (default 0).
- `update-role <role>`: resolve role id by re-fetching the team (`get_team`) and matching `name`. Then `mcp__sapling__update_team_role({ id, ...patch })`.
- `remove-role <role>`: same id resolution. `mcp__sapling__remove_team_role({ id })`.

### Defaults

- `set-default <work_type> <team> [app <app>]`:
  1. Resolve `team_id` via `get_team({ name: <team>, app_id })`.
  2. Resolve `app_id` for the default scope (separate from the team's scope — you can attach a global team as the default for one app).
  3. `mcp__sapling__set_team_default({ work_type, team_id, app_id? })`.
- `clear-default <work_type> [app <app>]`: `mcp__sapling__clear_team_default({ work_type, app_id? })`. Refuse gracefully (`not_found`) if there is no matching row.

## Notes

- A team's `app_id` and a default's `app_id` are independent. A global team (`team.app_id = NULL`) can be set as the default for app `iris` (`team_default.app_id = iris.id`); a per-app team can only be attached to work items whose service belongs to that same app (the server enforces this in `enqueue_work`).
- Defaults are resolved at enqueue time and stored on the work item. Changing a default later does not retroactively reroute pending items.
- When a team is deleted, referencing items have `work_items.team_id` set to `NULL` automatically — they revert to solo agent execution.
