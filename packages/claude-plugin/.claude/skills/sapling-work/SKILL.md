---
name: sapling-work
description: Pull the next pending Sapling work item and execute it. Triggers on /sapling:work.
---

# /sapling:work

Claim the next pending work item from Sapling and execute it in this session.

## Steps

1. Call MCP tool `mcp__sapling__claim_next_work` with `claimed_by` set to a stable agent label
   (e.g. `claude-${HOSTNAME}` from the env). Optional: pass `types` if the user specified
   a filter in arguments (e.g. `/sapling:work code` -> `types: ['code']`).
2. If the result is `null`, tell the user: "No pending work in the Sapling queue. Add one with /sapling:plan or /sapling:enqueue." and stop.
3. Otherwise, branch on `type`:

### type = 'plan'

- Read `description_markdown`, `service_id` (if set: `mcp__sapling__get_service`).
- Use the superpowers:brainstorming and superpowers:writing-plans skills as needed.
- Once the plan is drafted, call `mcp__sapling__create_plan` to persist it.
- Optionally call `mcp__sapling__enqueue_work` for follow-on `code` tasks linked via `plan_id`.
- Call `mcp__sapling__complete_work` with `id` and a one-paragraph `summary_markdown`.

### type = 'code'

- If `plan_id` is set, call `mcp__sapling__get_plan(id=plan_id)` and read the body.
- If `service_id` is set, call `mcp__sapling__get_service(id=service_id)` to load conventions, repo URL, tech stack.
- Do the actual work in the relevant repo on disk (filesystem, git). Sapling does not own the code.
- For notable artifacts (review notes, draft snippets), call `mcp__sapling__attach_artifact` with `work_item_id`.
- When done, optionally `mcp__sapling__enqueue_work(type='review', branch=..., pr_url=...)`.
- Call `mcp__sapling__complete_work` with `summary_markdown`.

### type = 'review'

- Read `branch` / `pr_url` from the work item.
- Inspect the diff (filesystem, `gh pr diff`, etc.).
- Call `mcp__sapling__attach_artifact(kind='review_notes', body_markdown=..., work_item_id=...)`.
- Call `mcp__sapling__complete_work` with the artifact id and summary.

## Failure handling

If you cannot complete the work, call `mcp__sapling__fail_work(id, reason)` with a clear reason
and stop. Do not loop on `claim_next_work` automatically — let the user decide.
