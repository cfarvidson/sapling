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
4. **Load binding rules.** If `service_id` is set, call `mcp__sapling__get_service` and `mcp__sapling__get_app({ id: service.app_id })`. Treat both `app.conventions` and `service.conventions` as non-negotiable rules for everything that follows — planning decisions, code style, where review notes get published, etc. If a rule conflicts with the task as written, halt and ask the user; do not silently violate. The user can manage these via `/sapling:rules`.
5. Branch on `type`:

### type = 'plan'

The goal is to finish this branch with an **`active` plan** — i.e. one a code task can run against without further input — not a `draft` parking lot. Don't persist + complete until the loose ends are resolved.

- Read `description_markdown`, `service_id` (if set: `mcp__sapling__get_service`).
- Use the superpowers:brainstorming and superpowers:writing-plans skills as needed.
- Plans typically don't produce commits, but exploration still happens in the worktree so any scratch edits stay isolated.
- **Surface every open question before writing the plan.** While drafting, keep a running list of: ambiguous requirements ("does X include Y?"), unspecified data shapes / API contracts, missing acceptance criteria, choice points where two reasonable approaches exist, integrations / dependencies whose behaviour you assumed, rollout / migration / backwards-compat concerns, and test strategy gaps.
- **Ask in batched rounds.** Send one message containing all current open questions (numbered list), wait for answers, integrate them, then ask again only if new questions surfaced from the answers. Don't drip questions one at a time. Don't paper over uncertainty with vague language — resolve it before persisting.
- Only when there are no open questions left, persist the plan with `mcp__sapling__create_plan({ ..., status: 'active' })`. If the user explicitly asks to defer ("park this as draft, I'll review later"), pass `status: 'draft'` instead and tell them how to flip it (`/sapling:queue plan <id> activate`).
- Offer to enqueue follow-on `code` work (`mcp__sapling__enqueue_work({ type: 'code', plan_id, service_id, title, description_markdown, branch })`). Default to "yes, one item per logical step in the plan"; let the user veto.
- Call `mcp__sapling__complete_work` with `id` and a `summary_markdown` that names the new plan id, its status, and any follow-on work item ids.

### type = 'code'

- If `plan_id` is set, call `mcp__sapling__get_plan(id=plan_id)` and read the body. If status is `draft`, halt and surface the plan to the user — drafts are unverified, do not execute against them. (`completed`/`archived` plans should also halt with a "stale plan" warning.)
- Service + app rules are already loaded in step 4 — the rules are binding for this work item.
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
