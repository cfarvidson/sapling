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

3. **In parallel, call** `mcp__sapling__list_projects({ app_name? })`. Project rows include `id`, `title`, `status`, `app_name`, `linear_url`. Skip this call entirely (and skip rendering the Projects section) if it returns an empty array.

4. Group the work-item rows by `app_name`. Sort apps alphabetically; render `(unassigned)` last. For each app, output the **Projects section** first if any project exists for that app, then the work sections:

```

## <app-name>

PROJECTS SCOPING <s> IN_PROGRESS <i> BLOCKED <b> DONE <d> CANCELLED <c> #<id> <status> <title> (linear: <url?>)
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

5. After the per-app sections, print a one-line cross-app totals row:

   ```
   TOTALS PROJECTS <P_total> PENDING <P> CLAIMED <C> AWAITING <A> (oldest <A_oldest>) BLOCKED <B> FAILED <F>
   ```

   `A_oldest` is the largest age across all awaiting_input rows in scope, formatted with the same `Nm` / `Nh` / `Nd` rule. Suppress the `(oldest …)` parenthetical entirely when `A == 0`.
