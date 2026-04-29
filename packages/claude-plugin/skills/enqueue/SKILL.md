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
  "team_id": <id if `team <name>` was passed>
}
```

If `team_id` is omitted, the server applies the resolution chain: per-app default → global default → null (solo agent).

5. Confirm: "Queued <type> task #<id>." If a team was attached (explicit or via default), include "team=<team_name>" in the confirmation so the user can see what will run.
