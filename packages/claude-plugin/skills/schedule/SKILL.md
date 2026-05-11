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
