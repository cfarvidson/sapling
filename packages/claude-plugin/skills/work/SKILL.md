---
name: work
description: Pull the next pending Sapling work item and execute it. Triggers on /sapling:work.
---

# /sapling:work

Claim the next pending work item from Sapling and execute it in this session.

## GitHub-bound text: never use `#N` for Sapling ids

Anything you write that will end up on GitHub — PR titles, PR bodies, PR comments, review notes posted to a PR, commit messages — MUST NOT use `#<n>` to reference a Sapling work item, plan, or artifact id. GitHub auto-links `#123` to issue/PR 123 in the current repo, producing broken links to unrelated PRs.

Use one of these forms instead:

- `Sapling work 6`, `Sapling plan 2`, `Sapling artifact 9`
- `sapling work item 6`

The `#N` form is fine in chat output to the user and inside Sapling artifacts (review_notes body, summaries) since neither passes through GitHub's auto-link logic. The rule only applies when the text crosses into GitHub.

This rule is non-negotiable and applies to every type below.

## Steps

1. Parse the slash arguments. Each bareword is one of:
   - `plan`, `code`, `review` → add to `types`;
   - any other token → treat as `app_name` (must already be registered in Sapling; at most one).

   Examples: `/sapling:work` → no filter; `/sapling:work iris` → `app_name: 'iris'`; `/sapling:work code` → `types: ['code']`; `/sapling:work iris code` → both.

2. Call `mcp__sapling__claim_next_work` with `claimed_by` set to a stable agent label (e.g. `claude-${HOSTNAME}` from the env) plus the `types` and `app_name` parsed above. The server scopes the claim by joining `services → apps`, so an app filter only picks items whose `service_id` belongs to that app — items with `service_id = null` are excluded when an app filter is set.

   If the response is a `not_found` error for the app, stop and tell the user: "App `<name>` is not registered. Run `/sapling:learn <name> …` first or call without the app filter."

   If the response is `null`, tell the user: "No pending work in the Sapling queue<scope>. Add one with /sapling:plan or /sapling:enqueue." where `<scope>` is e.g. ` for app iris` when an app filter was applied.

2b. **Rename the tmux window on every meaningful status transition (when running under the Sapling TUI).** This keeps the live window name aligned with the work item's status so the TUI's dashboard, `tmux switch-client`, and tmux's own window list stay readable. The format is `work-<id>:<status>`. This is a no-op when not running inside a Sapling-managed tmux session.

The helper to use everywhere this skill mutates work-item status:

```bash
sapling_rename_window() {
  if [ -n "$SAPLING_TMUX_SESSION" ] && [ -n "$TMUX_PANE" ]; then
    tmux rename-window -t "$TMUX_PANE" "work-$1:$2" 2>/dev/null || true
  fi
}
```

Call `sapling_rename_window <id> <status>` at each of these points:

- Immediately after `mcp__sapling__claim_next_work` returns a non-null work item: `sapling_rename_window <id> claimed`.
- Immediately after `mcp__sapling__request_human_input` succeeds (you are pausing on a question): `sapling_rename_window <id> awaiting_input`.
- Immediately after `mcp__sapling__complete_work` succeeds: `sapling_rename_window <id> complete`.
- Immediately after `mcp__sapling__fail_work` succeeds: `sapling_rename_window <id> failed`.

Substitute `<id>` with the work item id and `<status>` with the literal token shown above. The runner sets `SAPLING_TMUX_SESSION` only when it spawned this agent into a tmux window; outside that environment the variable is unset and the rename is skipped. Do not warn the user if the rename fails — tmux is not a hard dependency.

### Workspace safety (non-negotiable)

These invariants MUST hold for every worktree the skill creates or operates in. If any check fails, the skill MUST halt with a clear error message naming the offending value — do not silently rewrite, fall back, or relocate. They gate every subsequent step in this skill.

1. **Branch name allowlist.** The branch used for the worktree MUST match the regex `^[A-Za-z0-9._/-]+$`. If the work item's `branch` field contains anything else (spaces, shell metacharacters, leading `-`, control chars, …), halt with `branch '<value>' contains characters outside [A-Za-z0-9._/-]`. Do not strip or substitute. If `branch` is absent, derive one (`sapling/work-<id>` or the Linear `gitBranchName`) and apply the same regex check before use.
2. **Worktree path constraint.** Compute `repo_root = git rev-parse --show-toplevel` in the host repo. The worktree path MUST be `<repo_root>/.worktrees/<sanitized-tail>`, where `<sanitized-tail>` is the final `/`-segment of the validated branch name (already passes the regex above, so no extra sanitization is needed beyond taking the basename). After creation — or before, if the directory pre-exists — resolve the path with `realpath` (or equivalent) and verify it lies under `<repo_root>/.worktrees/`. If `realpath` of the candidate escapes that prefix (symlink, `..`, absolute override), halt.
3. **`cwd` assertion before every subprocess.** Before running any subprocess against the worktree (`git`, `gh`, `npm`/`pnpm`, build/test/lint, `cd`-into shell commands, …), assert that the current working directory equals the validated worktree path. If a tool call would run from elsewhere, prefix it with the explicit `cd <validated-path> && …` form rather than relying on inherited `cwd`. This catches the failure mode where an earlier `cd` was reverted by a fresh shell.

Step 3 below MUST consume the values produced by these checks; it must NOT re-derive the branch name or worktree path from scratch.

3. **Always work in an isolated git worktree, branched from latest `origin/main`.** Never run code/review/plan exploration against the user's primary checkout — that risks dirtying state and crossing into in-progress work. Use the `superpowers:using-git-worktrees` skill to create the worktree before touching the filesystem.
   - Resolve the repo from `service_id` (`mcp__sapling__get_service` → `repo_url`). If no `service_id` or `repo_url`, ask the user where to work before proceeding.
   - **Fetch first.** Before creating the worktree, `git fetch origin main` (or the repo's default branch — confirm with `git symbolic-ref refs/remotes/origin/HEAD` if you're unsure) so the new branch is rooted on today's tip of main, not whatever stale ref is in the local checkout. For `review`-type items, fetch the PR's target branch too. Skip the fetch only if the user explicitly asks you to base the worktree on a different ref.
   - **Branch name and worktree path:** use the validated values produced by the "Workspace safety" section above — do not re-derive them here. Create the new branch from `origin/main`: `git worktree add -b <validated-branch> <validated-path> origin/main`. Never branch from local `main`, which may be behind.
   - **`cwd` assertion:** before the first subprocess runs against the new worktree, confirm `cwd` matches `<validated-path>` (per the safety section). If it doesn't, prefix the command with `cd <validated-path> && …` rather than trusting the inherited shell.
   - Persist the chosen branch back on the work item (via the artifact you produce or by passing `branch` when enqueueing follow-on items) so reviewers can find it.
   - `cd` into the validated worktree path for the rest of the steps. All edits, commits, and `gh` calls happen there.
4. **Load binding rules.** If `service_id` is set, call `mcp__sapling__get_service` and `mcp__sapling__get_app({ id: service.app_id })`. Treat both `app.conventions` and `service.conventions` as non-negotiable rules for everything that follows — planning decisions, code style, where review notes get published, etc. If a rule conflicts with the task as written, halt and ask the user; do not silently violate. The user can manage these via `/sapling:rules`.

4b. **Load team (if assigned).** If the claimed work item has `team_id`, call `mcp__sapling__get_team({ id: team_id })`. The result is your team definition. Treat the rest of this work item as **lead mode**:

- Prepend `team.lead_prompt_md` to your operating instructions for this item. Treat it like a service convention — binding, not a suggestion.
- You have the following specialists available, in dispatch-list order:
  ```
  for role in team.roles:
    name=<role.name>
    description=<role.description_md>
    subagent_type=<role.subagent_type or "general-purpose">
  ```
- Dispatch a specialist via the `Agent` tool when the work demands it. Use `role.description_md` as the high-signal context for the specialist's prompt (combine it with the specific question/task). Use `role.subagent_type` if present; otherwise `general-purpose`.
- You remain the only writer to the filesystem and the only caller of `mcp__sapling__attach_artifact`, `mcp__sapling__complete_work`, and `mcp__sapling__request_human_input`. Specialists return text to you; you decide what to commit, what to attach as an artifact, and how to summarize.
- In your `complete_work` `summary_markdown`, mention which specialists you dispatched and what each contributed (one bullet per specialist is enough). This is the canonical record of team activity.
- If a specialist surfaces a question you cannot resolve, escalate via `mcp__sapling__request_human_input` exactly as solo mode would (the `$SAPLING_RUNNER` rule applies the same way — see the `type = 'plan'` section).

If `team_id` is null, skip this step entirely and continue in **solo mode** (everything below behaves as it always has).

4c. **Load project (if assigned).** If the claimed work item has `project_id`, call `mcp__sapling__get_project({ id: project_id })`. The result anchors what success looks like for this work item.

- Treat the project's `description_md` and especially `definition_of_done_md` as binding context. Every decision you make on this work item — what to plan, what to code, what to flag in review — must serve the DoD.
- If `get_project` returns `scoping_artifact_id` non-null, also call `mcp__sapling__get_artifact({ id: scoping_artifact_id })` and read the body before doing anything else. The scoping artifact tells you which services the project touches and what each one needs.
- If `get_project` returns a non-null `linear_url` on the project, treat the following as a non-negotiable rule for this work item:
  > _"This work item is part of project Sapling project N (`<title>`), tracked at `<linear_url>`. When you call `complete_work`, also post a brief comment on the Linear ticket summarising what you did, using `mcp__linear-work__save_comment` with the parsed Linear issue id. If your work is the DoD verifier (`is_dod_verifier=true`), the Linear comment is the canonical 'project done' summary."_
  > Apply the GitHub-id rule above when composing the Linear body — write `Sapling project N` / `Sapling work N`, not `#N`.
- If the work item is `is_dod_verifier=true` (this only happens for `review` items auto-enqueued at the end of a project), additional rules apply:
  - Re-read `definition_of_done_md` and check each criterion against shipped reality (open and merged PRs, tests, deployed code).
  - On success: complete normally with a `summary_markdown` listing each criterion and the evidence you saw. The server will flip the project to `done`.
  - On failure: attach a `dod_gaps` artifact (`mcp__sapling__attach_artifact(kind='dod_gaps', work_item_id=<id>, body_markdown=<numbered list of unmet criteria>)`) and `complete_work` normally. The project will stay `in_progress` and a human can `enqueue_work` more work + `retry_project`. Do NOT call `fail_work` for a failed DoD verification — failure here is a known, structured outcome, not an internal error.

If `project_id` is null, skip this step entirely; the rest of the skill behaves exactly as it always has.

5. **Resume context: integrate prior questions and answers.** Call `mcp__sapling__list_artifacts({ work_item_id: <id> })`. If both a `pending_questions` and a newer `answers` artifact exist (compare `created_at`), fetch both bodies via `mcp__sapling__get_artifact` and treat the answers as authoritative resolutions of the questions before continuing. Skip if either is missing — the item is being worked on for the first time.
6. Branch on `type`:

### type = 'plan'

The goal is to finish this branch with an **`active` plan** — i.e. one a code task can run against without further input — not a `draft` parking lot. Don't persist + complete until the loose ends are resolved.

- Read `description_markdown`, `service_id` (if set: `mcp__sapling__get_service`).
- Use the superpowers:brainstorming and superpowers:writing-plans skills as needed.
- Plans typically don't produce commits, but exploration still happens in the worktree so any scratch edits stay isolated.
- **Surface every open question before writing the plan.** While drafting, keep a running list of: ambiguous requirements ("does X include Y?"), unspecified data shapes / API contracts, missing acceptance criteria, choice points where two reasonable approaches exist, integrations / dependencies whose behaviour you assumed, rollout / migration / backwards-compat concerns, and test strategy gaps.
- **Ask in batched rounds.** Send one message containing all current open questions (numbered list), wait for answers, integrate them, then ask again only if new questions surfaced from the answers. Don't drip questions one at a time. Don't paper over uncertainty with vague language — resolve it before persisting.
- **Autonomous fallback when there is no human in the loop.** Check `$SAPLING_RUNNER` early. **If `$SAPLING_RUNNER=1` (the runner spawned you, there is no interactive user):** any open question — even one — means you MUST call `mcp__sapling__request_human_input({ work_id, questions_markdown })` with every unresolved question as a numbered markdown list, and then exit. Do NOT print plain-text questions to stdout (nothing will read them). Do NOT guess. Do NOT persist a half-baked plan. Do NOT call `complete_work` or `fail_work` on this path. The work item flips to `awaiting_input`, the runner skips it on subsequent ticks, and the user discovers it via `/sapling:human`. Once they answer, the item flips back to `pending` and a future `/sapling:work` run picks up step 5 (resume context) and continues with the answers in hand. **If `$SAPLING_RUNNER` is unset (interactive session):** ask the user directly in chat as described above; only fall back to `request_human_input` if they explicitly disengage.
- **Plan stress-test (when team_id is set).** Before persisting the plan, if `team_id` is set on the work item and the team's role list (loaded in step 4b) names any `ce-*` subagent_type, dispatch every specialist in the role list in parallel via the `Agent` tool. Each gets the draft plan body and the work item's `description_markdown`. Include this verbatim in every dispatch prompt: "Return findings as a markdown list, max 10 bullets, prioritized by severity. Do not call `attach_artifact`, `complete_work`, `request_human_input`, or any filesystem-writing tool." Skip individual specialists whose `ce-*` subagent_type is not available in the host's agent list (record the skipped names in the artifact's internal notes section). Aggregate every specialist's findings into ONE artifact: `mcp__sapling__attach_artifact({ kind: 'plan_review', work_item_id, body_markdown })`. Body layout: `**Plan readiness: READY | NEEDS REVISION** — one-line reason.` on the first line, then a `## Must fix before activation` checklist (omit when empty), then one `<details>` section per reviewer with their full output. If any specialist returns a blocker you can resolve by editing the plan, do so and re-dispatch ONLY the affected specialists for re-evaluation. Cap the edit-and-re-dispatch loop at **two** rounds: if a third pass would be needed (a specialist still flags the same class of blocker after one targeted revision), batch the remaining open questions into a `request_human_input` call and exit rather than spinning. If a blocker requires a human decision (architectural fork, missing requirement, ambiguous acceptance criteria), batch the open questions into a `request_human_input` call and exit on the first round — do not persist the plan as `active` with unresolved blockers.
- Only when there are no open questions left, persist the plan with `mcp__sapling__create_plan({ ..., status: 'active' })`. If the user explicitly asks to defer ("park this as draft, I'll review later"), pass `status: 'draft'` instead and tell them how to flip it (`/sapling:queue plan <id> activate`).
- Offer to enqueue follow-on `code` work (`mcp__sapling__enqueue_work({ type: 'code', plan_id, service_id, title, description_markdown, branch })`). Default to "yes, one item per logical step in the plan"; let the user veto.
- Call `mcp__sapling__complete_work` with `id` and a `summary_markdown` that names the new plan id, its status, and any follow-on work item ids.

### type = 'code'

- If `plan_id` is set, call `mcp__sapling__get_plan(id=plan_id)` and read the body. Drafts are unverified, do not execute against them. Stale plans (completed / archived) likewise should not run.
  - **`status: 'draft'` →** persist the open question via `mcp__sapling__request_human_input({ work_id, questions_markdown })` with a numbered list ("Plan N is draft. Should I (1) activate it and proceed, (2) release the claim so you can rework the plan first, or (3) fail this work item?"). The tool atomically writes a `pending_questions` artifact, flips status to `awaiting_input`, and releases the claim. Then exit. Never print the question to stdout _only_ — sessions can close, and a chat-bound prompt with no persisted artifact is unrecoverable except via `retry_work` after `claim_expires_at` passes. If you are in an interactive session (`$SAPLING_RUNNER` unset) you MAY _additionally_ ask the user in chat for an immediate answer, but the `request_human_input` call must happen first so the question survives session loss; the user can answer in chat (you call `provide_human_input` for them) or later via `/sapling:human`.
  - **`status: 'completed'` or `'archived'` →** this isn't a user question, it's stale state. Call `mcp__sapling__block_work({ id, reason: "plan N is <completed|archived>; needs a fresh plan or re-target" })` and exit. The user can repoint or fail the item via `/sapling:queue`.
- Service + app rules are already loaded in step 4 — the rules are binding for this work item.
- Do the actual work inside the worktree from step 3 (filesystem, git). Sapling does not own the code.
- For notable artifacts (review notes, draft snippets), call `mcp__sapling__attach_artifact` with `work_item_id`.
- When done, optionally `mcp__sapling__enqueue_work(type='review', branch=..., pr_url=...)` — pass the worktree's branch.
- Call `mcp__sapling__complete_work` with `summary_markdown`.

### type = 'review'

- Read `branch` / `pr_url` from the work item.
- Check out `branch` into the worktree from step 3 so the diff inspection happens in isolation. Use `gh pr diff` as a complement, never as a replacement for an isolated checkout when you intend to run code.
- **Determine authorship.** Run `gh pr view <pr_url> --json author` and compare its `author.login` to `gh api user --jq .login` (the local `gh` identity). Equal → self-authored. The check is purely on the local `gh` login; do not try to second-guess via commit authors or branch prefixes.

- **CE specialist dispatch matrix.** When `team_id` is set on the claimed item AND the team's role list (loaded in step 4b) names any `ce-*` subagent*type, fan out reviewer specialists via the `Agent` tool before composing the verdict. The matrix is \_additive*: every applicable row dispatches; the lead is the only writer.

  Always dispatch these four specialists in parallel (one Agent call per specialist, all in the same message). Each gets the diff (`git diff origin/<base>...HEAD` against the PR's target branch), the work item's `description_markdown`, and the project's `definition_of_done_md` (if `project_id` is set) as context.
  - `ce-correctness-reviewer`
  - `ce-maintainability-reviewer`
  - `ce-testing-reviewer`
  - `ce-project-standards-reviewer`

  Add conditional specialists based on what the diff touches. Multiple rows can fire on a single diff — dispatch each match.

  | Trigger (in the diff)                                                                                                                  | Add specialist                                                                                                                                                                                                |
  | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Path matches `auth`, `login`, `session`, `token`, `permission`                                                                         | `ce-security-reviewer`                                                                                                                                                                                        |
  | Touches `**/schema/*.sql`, `db/migrate/*`, `prisma/migrations/*`, or any file containing `CREATE TABLE`/`ALTER TABLE`                  | `ce-data-migrations-reviewer` + `ce-schema-drift-detector`                                                                                                                                                    |
  | Touches database queries or query-builder files, or adds >30 LOC with visible loops over collections of unknown size                   | `ce-performance-reviewer`                                                                                                                                                                                     |
  | Touches public type definitions, exported interfaces, top-level `index.ts` exports, OpenAPI/JSON-schema files, or CLI flag definitions | `ce-api-contract-reviewer`                                                                                                                                                                                    |
  | Touches retries, timeouts, circuit breakers, health checks, background jobs, async handlers, or error-recovery code paths              | `ce-reliability-reviewer`                                                                                                                                                                                     |
  | `gh pr view --json reviews,comments` returns any prior reviews/comments                                                                | `ce-previous-comments-reviewer`                                                                                                                                                                               |
  | Diff is large (>500 LOC changed) OR touches auth/payments/data-mutating endpoints/external API integrations                            | `ce-adversarial-reviewer`                                                                                                                                                                                     |
  | Work item has `is_dod_verifier=true`                                                                                                   | Add ALL of: `ce-adversarial-document-reviewer`, `ce-product-lens-reviewer`, `ce-scope-guardian-reviewer`. Each gets the project's `definition_of_done_md` plus links to merged PRs in the project as context. |

  **Specialist contract.** Include this verbatim in every dispatch prompt: "Return findings as a markdown list, max 10 bullets, prioritized by severity. Do not call `attach_artifact`, `complete_work`, `request_human_input`, or any filesystem-writing tool." Specialists return text. The lead synthesizes.

  **Resilience.** If a `ce-*` subagent_type is not available in the host's agent list (the compound-engineering plugin isn't installed), skip that specialist and continue. Do not fail the work item on missing agents; record the skipped names in the internal notes section of the artifact.

  **Aggregation into `review_notes`.** Compose ONE `review_notes` artifact using the standard body layout below. Merge by severity, not by speaker — collapse duplicate findings, prefer the more specific path:line. Map the aggregated blocker count to the verdict (zero blockers + non-author → APPROVE; one or more blockers + non-author → REQUEST_CHANGES; author → COMMENT regardless; explicit draft/WIP PR → COMMENT).

- **Reach a clear verdict.** Every review ends with exactly one of:
  - `APPROVE` — safe to merge, no blocking issues.
  - `REQUEST_CHANGES` — at least one blocker the author must address.
  - `COMMENT` — observations only, no merge-readiness judgement. Use this whenever you are the author (per the rule below) or when the PR is explicitly draft/WIP.
    Put `**Verdict: <STATE>**` on the first line of both the GitHub review body and the `review_notes` artifact, so the verdict is visible without expanding anything.
- **Body structure (collapsible by default).** The reader cares about the verdict and what blocks merge. Everything else lives behind `<details>` so the comment stays scannable. Use this layout for the GitHub body and the `review_notes` artifact (identical content, except internal-only notes — see below):

  ```markdown
  **Verdict: <APPROVE|REQUEST_CHANGES|COMMENT>** — one-line reason.

  ## Must fix before merge

  - [ ] <issue> — `path/to/file.ts:42`
  - [ ] <issue> — `path/to/other.ts:88`

  <!-- Omit the "Must fix" section entirely if there are no blockers. Don't write "None." -->

  <details>
  <summary>Nits & suggestions (N)</summary>

  - <nit> — `path:line`
  - …
  </details>

  <details>
  <summary>Files reviewed & scope</summary>

  - `path/...` — what you looked at
  - …
  </details>

  <details>
  <summary>Reviewer notes</summary>

  Rationale, alternatives considered, anything that informs the verdict but doesn't belong above the fold.

  </details>
  ```

  Rules:
  - **Verdict line and "Must fix" stay outside any `<details>`** so they render without a click.
  - Drop a `<details>` section entirely when it would be empty — don't ship empty disclosures.
  - Don't nest `<details>` deeper than one level.
  - Task-list checkboxes (`- [ ]`) inside `<details>` still work and count toward GitHub's task tracker — use them for nits the author may want to tick off.
  - Inline line comments (via `gh pr review ... --comment -F` with `--line`/`--path` if you choose to use them) are independent of this body and don't need `<details>`.

- **Post to GitHub with one style:**
  - **Self-authored:** always `gh pr review <pr_url> --comment --body-file <notes>`. Never `--approve` or `--request-changes` your own PR — those carry social weight that doesn't apply to a self-review. The verdict line still goes in the body so the next reader sees your assessment.
  - **Otherwise:** map the verdict to the matching flag — `--approve`, `--request-changes`, or `--comment`. Inline line comments are fine in either mode; the constraint is only on the top-level review state.
- Call `mcp__sapling__attach_artifact(kind='review_notes', body_markdown=..., work_item_id=...)` with the same body posted to GitHub. Internal-only notes (things you don't want on the PR) go below a `## Internal notes` heading at the very bottom of the artifact and MUST be stripped before posting to GitHub.
- Call `mcp__sapling__complete_work` with the artifact id and a summary that names the verdict.

## After completion

- **Plan roll-up nudge.** If the just-completed work item had a `plan_id`, call `mcp__sapling__list_work({ plan_id })`. If every sibling row is `completed` or `cancelled` and the plan's status is still `active`, ask the user: "All work for plan #N is terminal. Mark the plan `completed`?" — on yes, `mcp__sapling__update_plan({ id: plan_id, status: 'completed' })`. On no, leave it alone. Skip the prompt entirely if any sibling is still `pending`/`claimed`/`failed`.
- **Worktree cleanup.** Leave the worktree on disk if there's an open PR or follow-on work; otherwise tear it down with `git worktree remove` once the work item is `completed` and nothing else references it.

## Failure vs. blocked vs. awaiting_input

Distinguish "this work item went wrong" from "this work item can't progress yet" from "this work item needs the user to answer something":

- **Awaiting input** — autonomous planning hit unresolved questions and there is no interactive human to ask. Detect via `$SAPLING_RUNNER=1`. Call `mcp__sapling__request_human_input({ work_id, questions_markdown })` with a numbered list of every open question. The tool atomically writes a `pending_questions` artifact and flips status to `awaiting_input`; `claim_next_work` skips these items. The user discovers them via `/sapling:human` and answers in-session, which flips status back to `pending` and writes an `answers` artifact. A future `/sapling:work` run reloads both artifacts (step 5) and continues. Use only when guessing would produce a wrong plan — not as a substitute for in-session questions when the user is present.
- **Blocked** — the work itself is fine but waiting on something external that is NOT a user question: PR review, another Sapling work item that hasn't completed, infra/access not yet provisioned. Call `mcp__sapling__block_work({ id, reason })` with a specific reason ("waiting on PR review for cfarvidson/iris-493-…"). `claim_next_work` skips blocked items, so the queue keeps moving. The user (or an upstream completion) flips it back via `/sapling:queue work <id> unblock`.
- **Failed** — actually wrong: tests fail you can't fix, the plan turned out to be infeasible, the worktree is in a broken state you can't recover. Call `mcp__sapling__fail_work({ id, reason })`. Failures are not auto-retried.

In all three cases, stop after the call. Do not loop on `claim_next_work` automatically — let the user (or the runner, on its next tick) decide.
