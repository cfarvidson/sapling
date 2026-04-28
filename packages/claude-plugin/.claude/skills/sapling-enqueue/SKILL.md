---
name: sapling-enqueue
description: Enqueue a code or review task in Sapling. Triggers on /sapling:enqueue <code|review> <description>.
---

# /sapling:enqueue

Enqueue a `code` or `review` work item.

## Steps

1. Parse arguments: first token is `code` or `review`; the rest is the description.
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
  "pr_url": "<if provided>"
}
```

5. Confirm: "Queued <type> task #<id>."
