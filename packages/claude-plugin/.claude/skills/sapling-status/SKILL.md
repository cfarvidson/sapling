---
name: sapling-status
description: Show Sapling queue health (pending / claimed / completed counts). Triggers on /sapling:status.
---

# /sapling:status

Summarize the current state of the Sapling queue.

## Steps

1. Call `mcp__sapling__list_work` four times in parallel:
   - `{ status: 'pending' }`
   - `{ status: 'claimed' }`
   - `{ status: 'completed' }`
   - `{ status: 'failed' }`
2. Render a table:

```
PENDING:   <n>
CLAIMED:   <n>   (in flight)
COMPLETED: <n>
FAILED:    <n>
```

3. List the next 5 pending titles by `priority DESC, created_at ASC`.
4. List any FAILED items with their `failure_reason`.
