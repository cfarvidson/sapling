---
name: status
description: Show Sapling queue health (pending / claimed / blocked / failed) grouped by app. Triggers on /sapling:status.
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
2. Call `mcp__sapling__list_work` four times in parallel, passing `app_name` through if it was supplied:
   - `{ status: 'pending', app_name? }`
   - `{ status: 'claimed', app_name? }`
   - `{ status: 'blocked', app_name? }`
   - `{ status: 'failed', app_name? }`

   Each row in the response now carries `app_id` / `app_name` (resolved through `services`), so no separate join is needed. Items with no `service_id` (and therefore no app) are reported under the literal bucket `(unassigned)`.

   If the call returns a `not_found` error for the app, stop and tell the user the app isn't registered.

3. Group the rows by `app_name`. Sort apps alphabetically; render `(unassigned)` last. For each app, output:

   ```
   ## <app-name>           PENDING <p>  CLAIMED <c>  BLOCKED <b>  FAILED <f>
   pending:
     #<id>  <type>  <title>          (service=<service_id> plan=<plan_id>)
     …                                 (next 5, ordered by priority desc / created asc)
   claimed:
     #<id>  <type>  <title>          claimed_by=<claimed_by> @ <claimed_at>
     …                                 (every claimed row — stale claims are the #1 cause of
                                       "nothing to do", surface them all)
   blocked:
     #<id>  <type>  <title>
       reason: <failure_reason>
   failed:
     #<id>  <type>  <title>
       reason: <failure_reason>
   ```

   Skip empty subsections within an app to keep the output dense.

4. After the per-app sections, print a one-line cross-app totals row:

   ```
   TOTALS  PENDING <P>  CLAIMED <C>  BLOCKED <B>  FAILED <F>
   ```
