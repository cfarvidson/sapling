---
name: enqueue
description: Enqueue a code or review task in Sapling. Triggers on /sapling:enqueue <code|review> <description>.
---

# /sapling:enqueue

Enqueue a `code` or `review` work item.

## Steps

1. Parse arguments. Tokens:
   - First bareword: `code` or `review` (the work `type`).
   - Optional `team <name>` pair: pin a specific team to this item, overriding any default. `<name>` resolves against the work item's app scope (if a service is implied) — call `mcp__sapling__get_team({ name, app_id })` to get the id; on `not_found`, retry with `app_id` omitted (global team).
   - Optional trailing `after #<n>` token: chain this item behind an upstream Sapling work item. The runner won't claim the new item until work `#<n>` is `completed`. Use this for the natural review→fix flow (e.g. `/sapling:enqueue code address review findings after #83`).
   - Everything else is the description.
2. If a service is implied, resolve via `mcp__sapling__list_services`.
3. For `review`, ask the user (if not provided) for `branch` and/or `pr_url`.
4. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "<code|review>",
  "title": "<short title>",
  "description_markdown": "<full description>",
  "service_id": <id if known>,
  "branch": "<if provided>",
  "pr_url": "<if provided>",
  "team_id": <id if `team <name>` was passed>,
  "depends_on_work_id": <id if `after #N` was passed>
}
```

If `team_id` is omitted, the server applies the resolution chain: per-app default → global default → null (solo agent).

5. Confirm: "Queued <type> task #<id>." If a team was attached (explicit or via default), include "team=<team_name>" in the confirmation. If `after #N` was passed, append "(waiting on #<n>)" so the user knows it won't be claimed until the upstream completes.
