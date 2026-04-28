---
name: sapling-status
description: Show Sapling queue health (pending / claimed / completed counts). Triggers on /sapling:status.
---

# /sapling:status

Summarize the current state of the Sapling queue.

## Steps

1. Call `mcp__sapling__list_work` five times in parallel:
   - `{ status: 'pending' }`
   - `{ status: 'claimed' }`
   - `{ status: 'blocked' }`
   - `{ status: 'completed' }`
   - `{ status: 'failed' }`
2. Render a table:

```
PENDING:   <n>
CLAIMED:   <n>   (in flight)
BLOCKED:   <n>   (waiting on external dependency)
COMPLETED: <n>
FAILED:    <n>
```

3. List the next 5 pending titles by `priority DESC, created_at ASC`.
4. List **every** CLAIMED item — `#id type title — claimed_by @ claimed_at` — so the user can see exactly what's in flight and who/where. Stale claims (>30 min, or `claimed_by` matching a host that's no longer active) are the most common cause of "the queue says nothing to do" — surfacing them lets the user kick a stuck worktree or unblock manually.
5. List any BLOCKED items with their `failure_reason` (used as the block reason).
6. List any FAILED items with their `failure_reason`.
