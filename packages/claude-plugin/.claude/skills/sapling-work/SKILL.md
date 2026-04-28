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
3. **Always work in an isolated git worktree.** Never run code/review/plan exploration against the user's primary checkout — that risks dirtying state and crossing into in-progress work. Use the `superpowers:using-git-worktrees` skill to create the worktree before touching the filesystem.
   - Resolve the repo from `service_id` (`mcp__sapling__get_service` → `repo_url`). If no `service_id` or `repo_url`, ask the user where to work before proceeding.
   - Branch name: use the work item's `branch` field if set; otherwise derive one (e.g. `sapling/work-<id>` or, when a Linear ticket is referenced, the ticket's `gitBranchName`).
   - Persist the chosen branch back on the work item (via the artifact you produce or by passing `branch` when enqueueing follow-on items) so reviewers can find it.
   - `cd` into the worktree for the rest of the steps. All edits, commits, and `gh` calls happen there.
4. Branch on `type`:

### type = 'plan'

- Read `description_markdown`, `service_id` (if set: `mcp__sapling__get_service`).
- Use the superpowers:brainstorming and superpowers:writing-plans skills as needed.
- Plans typically don't produce commits, but exploration still happens in the worktree so any scratch edits stay isolated.
- Once the plan is drafted, call `mcp__sapling__create_plan` to persist it.
- Optionally call `mcp__sapling__enqueue_work` for follow-on `code` tasks linked via `plan_id` (set `branch` if you've already created one).
- Call `mcp__sapling__complete_work` with `id` and a one-paragraph `summary_markdown`.

### type = 'code'

- If `plan_id` is set, call `mcp__sapling__get_plan(id=plan_id)` and read the body.
- If `service_id` is set, call `mcp__sapling__get_service(id=service_id)` to load conventions, repo URL, tech stack.
- Do the actual work inside the worktree from step 3 (filesystem, git). Sapling does not own the code.
- For notable artifacts (review notes, draft snippets), call `mcp__sapling__attach_artifact` with `work_item_id`.
- When done, optionally `mcp__sapling__enqueue_work(type='review', branch=..., pr_url=...)` — pass the worktree's branch.
- Call `mcp__sapling__complete_work` with `summary_markdown`.

### type = 'review'

- Read `branch` / `pr_url` from the work item.
- Check out `branch` into the worktree from step 3 so the diff inspection happens in isolation. Use `gh pr diff` as a complement, never as a replacement for an isolated checkout when you intend to run code.
- Call `mcp__sapling__attach_artifact(kind='review_notes', body_markdown=..., work_item_id=...)`.
- Call `mcp__sapling__complete_work` with the artifact id and summary.

## After completion

Leave the worktree on disk if there's an open PR or follow-on work; otherwise tear it down with `git worktree remove` once the work item is `completed` and nothing else references it.

## Failure handling

If you cannot complete the work, call `mcp__sapling__fail_work(id, reason)` with a clear reason
and stop. Do not loop on `claim_next_work` automatically — let the user decide.
