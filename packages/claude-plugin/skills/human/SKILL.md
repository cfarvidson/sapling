---
name: human
description: Discover and answer Sapling work items that are paused waiting for user input. Triggers on /sapling:human.
---

# /sapling:human

Surface Sapling work items in the `awaiting_input` state and let the user answer them in-session. Answering flips the item back to `pending` so the runner re-claims it on the next tick.

This skill is the **pull-based** half of the human-in-the-loop flow. The runner-spawned planning agent transitions a stuck item to `awaiting_input` and exits; the user discovers it whenever they run this command. There is no proactive notification — pair with `/loop` if you want periodic check-ins.

## Forms

```
/sapling:human            — list every awaiting_input item with a one-line summary
/sapling:human <id>       — show one item's pending questions and prompt for answers
```

## Steps

### No args — list

1. Call `mcp__sapling__list_work({ status: 'awaiting_input' })`.
2. If the list is empty, print `Nothing waiting on you.` and stop.
3. For each item, fetch the latest `pending_questions` artifact via `mcp__sapling__list_artifacts({ work_item_id: <id>, kind: 'pending_questions' })` (sort by `id` descending, take the first). If none exists for some reason, render the row with `(no questions artifact found)` so the user can spot the inconsistency.
4. Render a table with these columns:
   - `id` — work item id (use `#<n>` form; this output never crosses into GitHub).
   - `app/title` — `<app_name>: <title>` (or just `<title>` if no app).
   - `plan` — `plan #<plan_id>` if set, blank otherwise.
   - `age` — humanized time since the artifact's `created_at` (e.g. `12m`, `3h`, `2d`).
   - `summary` — first non-empty line of `body_markdown`, trimmed to 80 chars; if the body has more than one numbered question, append ` (+N more)`.
5. Footer: `Run /sapling:human <id> to answer.`

### `<id>` arg — answer one item

1. Call `mcp__sapling__get_work({ id })`. If `status` is not `awaiting_input`, halt and tell the user: "Work #<id> is `<status>`, not `awaiting_input`. Nothing to answer."
2. If `plan_id` is set, call `mcp__sapling__get_plan({ id: plan_id })` and show the plan's `title` and `status` (one line) so the user has context.
3. Fetch the latest `pending_questions` artifact for the item (`list_artifacts` filtered by `work_item_id` and `kind`, take the most recent by `id`) and call `mcp__sapling__get_artifact` for its full body. Print the body verbatim in a fenced markdown block.
4. Prompt the user: "Type your answers as markdown (matching the question numbers). Send when ready." Wait for the response.
5. Call `mcp__sapling__provide_human_input({ work_id: <id>, answers_markdown: <user's reply> })`.
6. On success, confirm: "Answered work #<id>; status flipped to `pending`. The runner will pick it up on the next tick (or run `/sapling:work` to handle it now)."

## Notes

- **Discoverability is intentionally pull-based.** No outbound transports (Slack, iMessage, push, email) — those are unreliable, session-scoped, or both. If proactive nudging matters, pair this with `/loop 30m /sapling:human`.
- **Don't invent questions.** This skill only surfaces and answers what was persisted as a `pending_questions` artifact by the agent that paused the item. If the questions seem wrong or stale, use `/sapling:queue work <id> retry` to re-queue the item for a fresh planning pass, or `cancel` it.
- **GitHub-bound text rule still applies.** The `#<n>` form here is fine because this skill's output never crosses into GitHub — it's chat output and the `answers_markdown` body lives in a Sapling artifact. If you copy any of this into a PR, rewrite as `Sapling work N`.
