---
title: 'feat: Wire compound-engineering specialist agents into Sapling (Approach B)'
status: active
created: 2026-05-15
type: feat
depth: standard
---

# feat: Wire compound-engineering specialist agents into Sapling (Approach B)

## Summary

Sapling already has a `teams` primitive (lead + roles → dispatched via Claude Code's `Agent` tool with `subagent_type`) and a `team_defaults` per-(app, work_type) auto-attachment mechanism. The compound-engineering plugin ships ~49 specialist agents covering code review, planning-doc review, and research. This plan wires them together by (1) seeding canonical sapling-prefixed teams whose roles point at CE `subagent_type`s, (2) setting them as global defaults so new `plan`/`review` work items inherit them automatically, (3) fixing the DoD verifier auto-enqueue path so it honors `team_defaults` (it currently does not), and (4) teaching `/sapling:work` how to dispatch the right CE conditional reviewers via a small diff-content trigger matrix.

No new MCP tools. No DDL. No new artifact kinds — specialist outputs aggregate into the existing `review_notes`, `dod_gaps`, and `plan_review` shapes.

---

## Problem Frame

Today `/sapling:work` produces solo-agent output for every work item unless the user manually creates a team and sets a default. Quality therefore rests on one model pass over the diff or plan. Compound Engineering ships exactly the specialists that catch the failure modes solo passes miss — correctness regressions, weak tests, security/data-migration footguns, scope creep in plans, DoD gaps that look superficially satisfied. Sapling already has the team primitive to fan out and aggregate; it just lacks (a) the teams themselves, (b) wiring on the DoD verifier path, and (c) a deterministic-enough dispatch matrix in the lead skill so the right specialists fire each run instead of being reinvented in prose.

The brainstorm at the top of this session settled on Approach B (teams + dispatch matrix) over Approach A (teams only) and Approach C (new server-side `review_panel` primitive). B keeps all of A's value, adds the dispatch matrix where it has the highest leverage, and defers C's structural changes until the team + matrix shape proves out.

---

## Requirements

- **R1.** Three (or two — see Key Technical Decisions) canonical global teams ship as seed data: `sapling-code-review`, `sapling-plan-stress-test`, optionally `sapling-dod-verifier`. Names are stable, scoped `app_id = NULL` (global).
- **R2.** `team_defaults` are seeded: `(app_id=NULL, work_type='review') → sapling-code-review`; `(app_id=NULL, work_type='plan') → sapling-plan-stress-test`.
- **R3.** DoD verifier work items, auto-enqueued by `complete_work` in `projects.ts`, inherit `team_id` from `team_defaults` using the same resolution chain `enqueue_work` already uses. Today they always get `team_id = NULL`.
- **R4.** `packages/claude-plugin/skills/work/SKILL.md` carries a "CE specialist dispatch matrix" that the lead consults when `team_id` is set on the claimed item. The matrix enumerates: always-on specialists, conditional specialists keyed to diff content (touches `auth*` → security; touches `*/schema/*.sql` or `migrations/` → data-migrations + schema-drift; touches loop-heavy code or queries → performance; touches public types/exports → api-contract; touches retries/timeouts/health-checks → reliability; PR with prior review comments → previous-comments; large/high-risk diff → adversarial), and panel aggregation rules.
- **R5.** For `type='plan'` items with a team attached, the lead dispatches `sapling-plan-stress-test`'s panel after `superpowers:writing-plans` produces a spec but before `complete_work`. Findings aggregate into a single `plan_review` artifact attached to the work item. Blockers surface via `request_human_input` rather than silently going into the plan body.
- **R6.** For `is_dod_verifier=true` review items, the dispatch matrix extends the standard review panel with `ce-adversarial-document-reviewer`, `ce-product-lens-reviewer`, and `ce-scope-guardian-reviewer`. The lead aggregates into the existing `review_notes` artifact and, on failure, the existing `dod_gaps` artifact — both already contractually consumed by the DoD fix loop.
- **R7.** Migration `013_seed_ce_teams.sql` is idempotent: re-running it on an existing database does not duplicate rows or overwrite user edits to seeded teams. `ON CONFLICT ... DO NOTHING` on the unique constraints.
- **R8.** Plugin version bump per `CLAUDE.md` rule — new agent behavior downstream users will notice = minor (`0.11.0 → 0.12.0`).
- **R9.** `SPEC.md` updated for the slash-command surface behavior change and the new seeded teams + defaults.
- **R10.** Solo mode preserved. Users can clear defaults (`/sapling:teams clear-default`) or delete the seeded teams; work items with `team_id IS NULL` continue to run as solo agents exactly as today.

---

## Scope Boundaries

**In scope:**

- Data-only SQL migration seeding teams + defaults.
- One-file change in `projects.ts` (and a small refactor extracting `team_defaults` resolution from `work.ts` into a shared helper).
- Edits to `packages/claude-plugin/skills/work/SKILL.md` adding the dispatch matrix and plan stress-test step.
- `plugin.json` version bump.
- `SPEC.md` update.
- Targeted tests (migration idempotence, DoD verifier auto-attach behavior).

**Outside this product's identity:**

- New MCP tools (e.g., `pick_review_panel`). Deferred to Approach C if/when needed.
- New schema (no DDL — `013_seed_ce_teams.sql` is INSERT-only).
- New artifact kinds. Aggregation reuses `review_notes` / `dod_gaps` / `plan_review`.
- Server-side hard-coding of CE agent names. The names live in the seeded rows; server code never references them directly.
- Replacing the existing review verdict format. The matrix produces inputs for the lead; the lead still writes the verdict per the existing skill rules.

### Deferred to Follow-Up Work

- Per-app variants of the seeded teams (e.g., `sapling-code-review` scoped to a specific app with framework-specific reviewers). Easy to add later via `/sapling:teams create … app <name>`.
- Slack/learnings research wiring into `type='code'` items.
- Auto-routing `ce-debug` for failing test work items.

---

## Key Technical Decisions

### KD1. Two seeded teams, not three

The brainstorm proposed three teams (`sapling-code-review`, `sapling-plan-stress-test`, `sapling-dod-verifier`). On closer reading of `packages/claude-plugin/skills/work/SKILL.md` § "type = 'review'" and the project lifecycle code, the DoD verifier is already a `type='review'` work item with `is_dod_verifier=true` and a binding `definition_of_done_md` loaded from the project. The lead-skill already has DoD-specific instructions. The DoD verifier therefore inherits everything the `sapling-code-review` team provides; it only needs _additional_ specialists.

**Decision:** Ship two teams. Extend the dispatch matrix so `is_dod_verifier=true` adds three DoD-specific specialists to the standard review panel. Saves one team row, one default row, one lead prompt to maintain, and avoids the "which team wins for a DoD verifier" precedence question.

**Override path:** if during review the user wants a distinct team (e.g., to attach a different lead prompt for verifiers), reintroducing `sapling-dod-verifier` is a one-row INSERT in a follow-up migration — no structural rework.

### KD2. Fix DoD-verifier team resolution as part of this PR, not a separate one

`enqueue_work` resolves `team_defaults`; the project auto-enqueue path in `projects.ts` does a direct INSERT and bypasses resolution. That's a latent gap that would silently break R3 if shipped without the fix. The fix is small: extract `resolveTeamDefault(appId, workType)` from `work.ts` into a tiny helper, call it from both insert sites.

This is the minimum server-side change. No new tool, no schema change.

### KD3. Dispatch matrix lives in skill markdown, not a server-side trigger table

The matrix is a small set of "if diff touches X, dispatch agent Y" rules that the lead applies. Putting them in the skill keeps them version-controlled with the plugin, lets the user edit them locally, and matches how CE's own `ce-code-review` skill works internally. Approach C's `review_panel` primitive would move the matrix into structured server data — deferred until we see the matrix actually drift across runs.

### KD4. Aggregate into existing artifact kinds

`review_notes` is already the canonical aggregated review output. `dod_gaps` is already the canonical DoD-failure structure. `plan_review` is a new kind name but reuses the existing `attach_artifact(kind=..., body_markdown=...)` shape — no enum change, no migration. ("Artifact kind" is just a TEXT label per the current schema, not an enum — verify in `001_init.sql` during implementation; fall back to a free-form `kind` value if so.)

### KD5. Specialists return text only — lead is the only writer

This is the existing invariant from `skills/work/SKILL.md` § "Load team (if assigned)". The dispatch matrix MUST NOT introduce specialists that call `attach_artifact`, `complete_work`, or filesystem writes directly. CE agents that have `Write`/`Edit` tools available are dispatched in advisory mode (`return findings, do not write`) — the lead aggregates and writes.

---

## Implementation Units

### U1. Migration: seed `sapling-code-review` and `sapling-plan-stress-test` teams + defaults

- **Goal:** Ship two global teams and two `team_defaults` rows as a data-only migration.
- **Requirements:** R1, R2, R7.
- **Dependencies:** none.
- **Files:**
  - `packages/mcp-server/src/schema/013_seed_ce_teams.sql` (new)
  - `packages/mcp-server/test/migration.013.test.ts` (new) — verify idempotence and row presence.
- **Approach:**
  - One SQL file. Three INSERT blocks: (1) `INSERT INTO teams(...)` for `sapling-code-review`, `app_id=NULL`, with `lead_prompt_md` capturing the review-panel posture. `ON CONFLICT (app_id, name) DO NOTHING`. (2) `INSERT INTO team_roles(...)` for the role list, one row per CE specialist (`ce-correctness-reviewer`, `ce-maintainability-reviewer`, `ce-testing-reviewer`, `ce-project-standards-reviewer`, plus the conditional list named in `description_md` so the lead can pick them up: `ce-security-reviewer`, `ce-data-migrations-reviewer`, `ce-schema-drift-detector`, `ce-performance-reviewer`, `ce-api-contract-reviewer`, `ce-reliability-reviewer`, `ce-previous-comments-reviewer`, `ce-adversarial-reviewer`). Each row's `subagent_type` is the bare CE agent name (matching the entries the host surfaces). (3) Same shape for `sapling-plan-stress-test` with roles pointing at `ce-feasibility-reviewer`, `ce-scope-guardian-reviewer`, `ce-coherence-reviewer`, `ce-security-lens-reviewer`, `ce-design-lens-reviewer`, `ce-product-lens-reviewer`, `ce-adversarial-document-reviewer`. (4) Two `INSERT INTO team_defaults(app_id, work_type, team_id)` rows, looking up team_id by name via a CTE; `ON CONFLICT ON CONSTRAINT team_defaults_uniq DO NOTHING`.
  - Pre-check: confirm `team_role` rows allow free-text `subagent_type` values (current schema says `TEXT`, nullable) — should be fine without coercion.
- **Patterns to follow:** existing `006_teams.sql` for `CREATE TABLE IF NOT EXISTS` shape; idempotency on every prior migration in `packages/mcp-server/src/schema/`; per-migration test pattern under `packages/mcp-server/test/`.
- **Test scenarios:**
  - Apply the migration on a fresh DB → exactly one row in `teams` for each seeded name (`app_id IS NULL`), exactly the right number of rows in `team_roles`, exactly two rows in `team_defaults`.
  - Re-apply the migration → no new rows; no errors.
  - User-edit safety: pre-INSERT a row with `(app_id=NULL, name='sapling-code-review')` containing a custom `lead_prompt_md`, then apply migration → user row is untouched (no UPDATE).
  - Pre-existing `team_defaults` for `work_type='review'` (global) is NOT overwritten — the seed INSERT is `ON CONFLICT DO NOTHING`.
- **Verification:** `make psql` after `make up`; `SELECT name, app_id FROM teams WHERE name LIKE 'sapling-%';` returns both teams. `SELECT work_type, team_id FROM team_defaults WHERE app_id IS NULL;` returns the two defaults.

### U2. Server: extract `resolveTeamDefault(...)` helper and use it from the DoD verifier auto-enqueue path

- **Goal:** Close the gap where DoD verifier work items always get `team_id = NULL`, regardless of `team_defaults`.
- **Requirements:** R3.
- **Dependencies:** U1 (so the test can rely on a default existing).
- **Files:**
  - `packages/mcp-server/src/tools/teams.ts` or `packages/mcp-server/src/lib/team-defaults.ts` (new file or appended to existing) — house the helper.
  - `packages/mcp-server/src/tools/work.ts` — replace inlined resolution with helper call.
  - `packages/mcp-server/src/tools/projects.ts` — call helper before the `INSERT INTO work_items(...)` for the DoD verifier at lines ~758.
  - `packages/mcp-server/test/projects.dod-verifier-team.test.ts` (new).
- **Approach:**
  - Extract the lines currently at `work.ts:118-134` (the per-app + global team_defaults lookup) into `async function resolveTeamDefault(db, appId, workType): Promise<number | null>`. Both callers pass the project's resolved `app_id` (NULL for a project whose first service has no `app_id`, or per the project's `app_id` if `projects` carries that — verify which during implementation; the DoD verifier work item is project-scoped, so the answer flows from the project's service set).
  - In `projects.ts` auto-enqueue (line ~758), compute `appId` the same way the project's other auto-enqueue paths do (already present for per-plan review enqueues — mirror that). Pass to `resolveTeamDefault(client, appId, 'review')`. Splice `team_id` into the INSERT.
  - Discovery to confirm in U2 implementation: read the per-plan review auto-enqueue block in the same file (search `is_dod_verifier=false`, line ~700-740) to see how it derives `app_id`. If projects don't reliably carry `app_id` directly, derive it via the first service on the project (`SELECT app_id FROM services WHERE id IN (SELECT service_id FROM work_items WHERE project_id=$1 LIMIT 1)`). Pick whichever path the existing per-plan review enqueue uses — do not invent a third resolution.
- **Patterns to follow:** existing per-plan review auto-enqueue in the same file (it already has app/service resolution), and the existing `enqueue_work` chain in `work.ts`.
- **Test scenarios:**
  - Project with no per-app default; global review default = `sapling-code-review` → completing the last non-verifier child auto-enqueues a verifier with `team_id` set to `sapling-code-review.id`.
  - Project where the user cleared the global default (`clear_team_default`) → auto-enqueued verifier has `team_id = NULL` (solo execution).
  - Project under app `iris` with a per-app default `iris-code-review` and a global default → verifier picks up the per-app default.
  - Backwards compatibility: pre-existing test `projects.test.ts` cases that assert team_id semantics on regular auto-enqueued reviews still pass.
- **Verification:** new test green; the wider `pnpm --filter sapling-mcp-server test` suite green.

### U3. Skill: add CE specialist dispatch matrix to `/sapling:work` (review branch)

- **Goal:** Teach the lead which CE specialists to dispatch for a `type='review'` item and how to aggregate their findings.
- **Requirements:** R4, R6, KD5.
- **Dependencies:** none (skill text is self-contained; the matrix references CE agents by name).
- **Files:**
  - `packages/claude-plugin/skills/work/SKILL.md` — new subsection under § "type = 'review'".
- **Approach:**
  - Add a "CE specialist dispatch matrix" subsection that fires only when the claimed work item has `team_id` set AND the team's role list includes any `ce-*` subagent_type. Structure:
    1. Always dispatch the four "always-on" specialists: correctness, maintainability, testing, project-standards. Each gets the diff (`git diff origin/<base>...HEAD`), the work item's `description_markdown`, and the project's `definition_of_done_md` (if any) as context. Prompt each with: "Return findings only. Do not write to disk."
    2. Conditional triggers (table form in the markdown): touches `**/auth*/**` or anything matching `(login|session|token|permission)` in path → also dispatch `ce-security-reviewer`. Touches `packages/*/src/schema/*.sql` or `migrations/` → also dispatch `ce-data-migrations-reviewer` and `ce-schema-drift-detector`. Loop-heavy or query-heavy diff (heuristic: >50 LOC in `.sql` or DB-access files, or visible `for`/`map`/`forEach` in changed lines on TS/Ruby/Python > 30 LOC) → `ce-performance-reviewer`. Touches public types, exports, or anything in `packages/*/src/lib/types*` or top-level `index.ts` → `ce-api-contract-reviewer`. Touches retry/timeout/health/circuit-breaker code or async job handlers → `ce-reliability-reviewer`. PR has prior review comments (detected via `gh pr view <pr_url> --json reviews,comments`) → `ce-previous-comments-reviewer`. Large diff (>500 LOC) or touches auth/payments/data mutations → `ce-adversarial-reviewer`.
    3. Special branch when `is_dod_verifier=true`: in addition to the standard review panel, dispatch `ce-adversarial-document-reviewer`, `ce-product-lens-reviewer`, `ce-scope-guardian-reviewer`. Each gets the project's `definition_of_done_md` plus the merged PRs / shipped reality as context.
    4. Aggregation: lead merges specialist outputs into a single `review_notes` body using the existing layout (`Verdict`, `Must fix`, collapsible sections). When `is_dod_verifier=true` and the merged finding set contains any blocker, lead ALSO attaches a `dod_gaps` artifact with a numbered list and calls `complete_work({ dod_verified: false })`. No `dod_gaps` on success.
    5. Specialist contract: the lead's dispatch prompt MUST include "Return findings as a markdown list. Do not call `attach_artifact`, `complete_work`, or filesystem-writing tools." (This is informational — specialists in subagent mode don't have those tools anyway, but the prompt makes intent explicit.)
- **Patterns to follow:** existing matrix-style trigger descriptions in CE's own `ce-code-review` skill (referenced, not copied — link with a one-line comment); existing review body format already in this skill.
- **Test scenarios:** _(skill text — no automated tests; verify manually in U6.)_
  - Dispatch a manual review work item with team_id set; confirm the lead dispatches the four always-on specialists.
  - Add an auth-touching diff and re-run; confirm `ce-security-reviewer` is also dispatched.
  - Set `is_dod_verifier=true` (via `block_work` / direct DB tweak in a test DB) and confirm the three DoD specialists are added.
- **Verification:** dry-run the skill against a recent merged PR in the sapling repo itself; confirm the lead produces a `review_notes` artifact whose body merges multiple specialist outputs.

### U4. Skill: add plan stress-test step to `/sapling:work` (plan branch)

- **Goal:** When a plan work item has a team attached (i.e., `sapling-plan-stress-test` via default), the lead dispatches the planning-doc reviewer panel after `superpowers:writing-plans` produces a spec and before `complete_work`.
- **Requirements:** R5, KD5.
- **Dependencies:** U3 (matrix conventions shared).
- **Files:**
  - `packages/claude-plugin/skills/work/SKILL.md` — new step under § "type = 'plan'".
- **Approach:**
  - After the `superpowers:writing-plans` step persists the plan but before `complete_work`, if `team_id` is set, dispatch the team's full role list (`ce-feasibility-reviewer`, `ce-scope-guardian-reviewer`, `ce-coherence-reviewer`, `ce-security-lens-reviewer`, `ce-design-lens-reviewer`, `ce-product-lens-reviewer`, `ce-adversarial-document-reviewer`) with the plan body as input. Each returns findings as a markdown list.
  - Aggregate into a single `plan_review` artifact (`attach_artifact(kind='plan_review', body_markdown=..., work_item_id=...)`). Body shape mirrors the review_notes layout: top-line "Plan readiness: READY | NEEDS REVISION", "Must fix before activation" list, collapsible sections per reviewer.
  - If any specialist returns a blocker, the lead does NOT call `complete_work` with the plan flipped to `active`. Instead: lead amends the plan to address tractable findings; for findings requiring human input, call `request_human_input(work_id, questions_markdown)` with a numbered list and exit.
- **Patterns to follow:** the existing `request_human_input` flow already documented in this skill's plan branch; the artifact body layout from § "type = 'review'".
- **Test scenarios:** _(skill text — see U6 for manual smoke test.)_
- **Verification:** manual smoke test on a real plan work item with the seeded default present.

### U5. Plugin version bump + SPEC.md update

- **Goal:** Document the behavior change, bump the plugin version per the `CLAUDE.md` rule.
- **Requirements:** R8, R9.
- **Dependencies:** U3, U4 (text is final).
- **Files:**
  - `packages/claude-plugin/.claude-plugin/plugin.json` — bump `version` `0.11.0 → 0.12.0`.
  - `SPEC.md` — update affected sections.
- **Approach:**
  - In `SPEC.md`: update the teams section to note that two CE-backed teams ship pre-seeded as global defaults; update the work-item lifecycle section to document the dispatch matrix entry points; update the project DoD section to note that the verifier inherits the review team default; mention the new `plan_review` artifact kind.
  - In `plugin.json`: bump version. Per `CLAUDE.md`: this is a minor bump because downstream users will notice new agent behavior (specialist dispatch).
- **Patterns to follow:** existing SPEC.md section structure; existing minor-bump pattern from prior plugin commits.
- **Test scenarios:** none (docs).
- **Verification:** `git diff SPEC.md packages/claude-plugin/.claude-plugin/plugin.json` reads cleanly and reflects the actual shipped behavior.

### U6. End-to-end smoke and lint

- **Goal:** Confirm the integration works as one motion against a real Sapling instance.
- **Requirements:** all.
- **Dependencies:** U1 – U5.
- **Files:**
  - `packages/mcp-server/test/migration.013.test.ts` (already in U1)
  - `packages/mcp-server/test/projects.dod-verifier-team.test.ts` (already in U2)
  - No new files for the smoke — manual procedure documented in the PR body.
- **Approach:**
  - Bring up a clean sapling DB (`make nuke && make up`). Confirm `SELECT * FROM teams`/`team_defaults` matches the seed.
  - Create a project on an app with a real GitHub repo, let the runner spawn `/sapling:work`, walk through one full project lifecycle (plan → code → review → DoD verifier). Confirm `plan_review` and `review_notes` artifacts appear; confirm DoD verifier item has `team_id` set.
  - Run `pnpm --filter sapling-mcp-server test` — green.
  - Run `npx prettier --write . && pnpm lint` per the global instructions; commit any formatting deltas.
- **Test scenarios:** none new beyond U1/U2.
- **Verification:** smoke procedure passes; CI green on the PR.

---

## System-Wide Impact

- **MCP tool surface:** unchanged. `SPEC.md` rule "MCP tool surface" does NOT require an update.
- **Slash-command surface:** unchanged tool list, but `/sapling:work` behavior is meaningfully different (specialist dispatch). `SPEC.md` rule "slash-command surface" DOES apply — update.
- **Data model:** new rows in `teams`, `team_roles`, `team_defaults`, but no new tables/columns/enums. `SPEC.md` rule "data model" does NOT apply (no new migration introducing schema; the migration only seeds).
- **Work-item lifecycle:** unchanged status set, unchanged transition rules. The verifier now starts with a `team_id` instead of NULL, but that's a runtime field, not a lifecycle change.
- **Runner configuration:** unchanged.

Downstream users on the previous plugin version will not see the new behavior until they reinstall (`/plugin install sapling@sapling`). The migration runs automatically on `make up`, so the server side comes for free.

---

## Risks and Mitigations

- **Risk:** Seeded teams collide with user-created teams of the same name. **Mitigation:** `ON CONFLICT (app_id, name) DO NOTHING`. User edits win; seed is a one-shot floor.
- **Risk:** Seeded defaults override a user's intentional default. **Mitigation:** `ON CONFLICT ON CONSTRAINT team_defaults_uniq DO NOTHING`. If the user has a default in place, the seed is a no-op.
- **Risk:** Specialist dispatch causes runaway agent fan-out for tiny diffs (e.g., a one-line typo fix dispatches four reviewers). **Mitigation:** the matrix's "always-on" list is small (4 specialists), each is a single agent invocation. Conditional triggers fire only on the specific diff shapes that warrant them. The lead remains one process from the runner's perspective (R3 in the existing teams spec).
- **Risk:** CE plugin not installed in the host environment → `subagent_type` lookup fails when the lead tries to dispatch. **Mitigation:** the skill text MUST note: "If a `ce-*` subagent_type is not available in the host's agent list, skip that specialist and continue. Do not fail the work item on missing agents." Document this once in the matrix subsection.
- **Risk:** Specialist output is too long for the lead to merge cleanly into one artifact. **Mitigation:** the lead's aggregation prompt tells specialists to return "at most 10 bullets, prioritized by severity." Existing CE agents already self-limit; the rule is reinforcement.

---

## Verification Strategy

- **Automated:** the two new tests in U1 and U2 plus the existing `packages/mcp-server/test` suite.
- **Manual smoke:** U6 procedure run once before opening the PR.
- **CI:** standard `pnpm test` + `pnpm lint`. No new CI workflows required.
- **Rollback:** revert the plugin commits + drop the seeded rows manually (`DELETE FROM team_defaults WHERE team_id IN (SELECT id FROM teams WHERE name LIKE 'sapling-%' AND app_id IS NULL); DELETE FROM teams WHERE name LIKE 'sapling-%' AND app_id IS NULL;`). No DDL to undo.

---

## Deferred to Implementation

- The exact `lead_prompt_md` bodies for the two seeded teams. Drafted during U1; reviewed in the PR.
- The exact `description_md` text per role (the lead reads these to decide when to dispatch each conditional specialist).
- Whether `attach_artifact`'s `kind` field is free-text or enum-constrained in the current schema (`001_init.sql`) — verify in U2; if enum-constrained, `plan_review` will need to be added to the enum, which DOES count as a schema change and forces a tiny `014_artifact_kind_plan_review.sql`. Flag this as a discovery point.
- The exact heuristic thresholds in the dispatch matrix (e.g., "large diff > 500 LOC"). Drafted during U3 based on real PRs in the sapling history.
