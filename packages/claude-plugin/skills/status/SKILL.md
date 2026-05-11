---
name: status
description: Show Sapling queue health (pending / claimed / awaiting_input / blocked / failed) grouped by app. Triggers on /sapling:status.
---

# /sapling:status

Summarize the current state of the Sapling queue, grouped by app so the user can see at a glance which products have stuck or queued work.

## Forms

```
/sapling:status            — every app, grouped
/sapling:status <app>      — only that app (errors clearly if the app isn't registered)
```

## Steps

1. Parse arguments: a single bareword is treated as `app_name`. No arg means "all apps".
2. Call `mcp__sapling__list_work` five times in parallel, passing `app_name` through if it was supplied:
   - `{ status: 'pending', app_name? }`
   - `{ status: 'claimed', app_name? }`
   - `{ status: 'awaiting_input', app_name? }`
   - `{ status: 'blocked', app_name? }`
   - `{ status: 'failed', app_name? }`

   Each row in the response now carries `app_id` / `app_name` (resolved through `services`), so no separate join is needed. Items with no `service_id` (and therefore no app) are reported under the literal bucket `(unassigned)`.

   If the call returns a `not_found` error for the app, stop and tell the user the app isn't registered.

3. **In parallel, call** `mcp__sapling__list_projects({ app_name? })`. Project rows include `id`, `title`, `status`, `app_name`, `linear_url`, `dod_cycle_count`. Skip this call entirely (and skip rendering the Projects section) if it returns an empty array.

3a. **In parallel, call** `mcp__sapling__get_runner_config({})` — read `max_dod_fix_cycles` for rendering the DoD cycle counter on Projects rows. The `github_token` field is already redacted server-side.

3b. **In parallel, call** `mcp__sapling__list_schedules({})`. If the result is non-empty, also gather the most recent failed run per schedule. The simplest pull pattern is: for each schedule whose `last_fired_at` is non-null AND older than its `next_run_at`, call `mcp__sapling__get_schedule({ id_or_name: id })` to fetch `last_run`. Skip schedules whose `last_run.status !== 'failed'`. Skip the entire schedule summary when `list_schedules` returned `[]`.

4. Group the work-item rows by `app_name`. Sort apps alphabetically; render `(unassigned)` last. For each app, output the **Projects section** first if any project exists for that app, then the work sections:

```

## <app-name>

PROJECTS SCOPING <s> IN_PROGRESS <i> BLOCKED <b> DONE <d> CANCELLED <c>
#<id> <status> <title> (linear: <url?> dod_cycle=<dod_cycle_count>/<max_dod_fix_cycles>)
…
PENDING <p> CLAIMED <c> AWAITING <a> (oldest <oldest_age>) BLOCKED <b> FAILED <f>
pending: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
… (next 5, ordered by priority desc / created asc)
claimed: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>) claimed_by=<claimed_by> @ <claimed_at>
… (every claimed row — stale claims are the #1 cause of
"nothing to do", surface them all)
awaiting_input: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>) (run /sapling:human <id> to answer)
blocked: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
reason: <failure_reason>
failed: #<id> <type> <title> (service=<service_id> plan=<plan_id> project=<project_id?> team=<team_name?>)
reason: <failure_reason>

```

Skip empty subsections (including the entire Projects header if no projects exist for that app) to keep the output dense. If `awaiting_input` count > 0, compute `oldest_age` = the largest `now() - updated_at` across the awaiting_input rows for that app, formatted as `Nm` for < 60 minutes, `Nh` for < 48 hours, else `Nd`. Suppress the `(oldest …)` parenthetical entirely when the count is zero. When a row's `team_name`, `plan_id`, or `project_id` is null, suppress that key entirely. If `awaiting_input` totals are non-zero anywhere, append `Run /sapling:human to answer.` to the footer.

When rendering each project row, suppress `dod_cycle=<n>/<cap>` entirely when `dod_cycle_count == 0`. When `dod_cycle_count == max_dod_fix_cycles - 1`, append a soft warning ` ⚠ last round` after the parenthetical so the user knows the next failed verification will cap-block the project.

4b. **Schedules summary** (only if `list_schedules` returned ≥1 row). Output a single section above the totals row:

    ```
    ## Schedules
    SCHEDULES <total> ENABLED <e> DISABLED <d>
    next fire: <ISO> — "<name>" (in <Nm|Nh|Nd>)
    last failure: <ISO> — "<name>" (<error>)
    ```

    "next fire" is the schedule with the smallest `next_run_at` among enabled rows. "last failure" is the most recent failed run across all schedules (only printed if at least one exists). If neither line has data to show, omit that line. If there are zero schedules, omit the entire Schedules section (matches how awaiting_input is omitted when zero).

5. After the per-app sections, print a one-line cross-app totals row:

   ```
   TOTALS PROJECTS <P_total> PENDING <P> CLAIMED <C> AWAITING <A> (oldest <A_oldest>) BLOCKED <B> FAILED <F>
   ```

   `A_oldest` is the largest age across all awaiting_input rows in scope, formatted with the same `Nm` / `Nh` / `Nd` rule. Suppress the `(oldest …)` parenthetical entirely when `A == 0`.
