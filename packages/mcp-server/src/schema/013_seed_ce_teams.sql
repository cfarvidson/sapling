-- Seed two global teams that fan out to compound-engineering specialist agents,
-- plus the global defaults that auto-attach them to new plan/review work items.
--
-- The teams are global (app_id = NULL). Their roles' subagent_type values match the
-- bare names compound-engineering ships its agents under (e.g., ce-correctness-reviewer).
-- The lead skill (packages/claude-plugin/skills/work/SKILL.md) interprets the role
-- list and dispatches via Claude Code's Agent tool when the work demands it.
--
-- All inserts are idempotent: if a user (or an earlier run) already created a row
-- with the same unique key, we leave their version untouched. The migration runner
-- itself only applies each file once (recorded in _migrations), but ON CONFLICT
-- DO NOTHING covers the case where a user pre-seeded a colliding name.

-- sapling-code-review --------------------------------------------------------
INSERT INTO teams (name, app_id, description, lead_prompt_md)
VALUES (
  'sapling-code-review',
  NULL,
  'Default review panel — dispatches compound-engineering specialists based on diff content.',
  $md$You are the lead reviewer. Your specialists are compound-engineering review agents.

For every review work item you claim with this team attached:

1. Always dispatch the four "always-on" specialists in parallel: ce-correctness-reviewer, ce-maintainability-reviewer, ce-testing-reviewer, ce-project-standards-reviewer. Each receives the diff (git diff against the base branch), the work item description, and the project definition_of_done_md (if any) as context. Tell each specialist: "Return findings as a markdown list. Do not call attach_artifact, complete_work, or any filesystem-writing tool."

2. Then consult the dispatch matrix in skills/work/SKILL.md (§ "CE specialist dispatch matrix") and dispatch any conditional specialists whose triggers fire for this diff.

3. When the work item has is_dod_verifier=true, additionally dispatch ce-adversarial-document-reviewer, ce-product-lens-reviewer, and ce-scope-guardian-reviewer with the project's definition_of_done_md as primary input.

4. Aggregate every specialist's findings into one review_notes artifact, using the standard review body layout (Verdict line, Must fix, collapsible Nits/Files/Reviewer notes). Drop empty sections. Map blocker count to verdict.

5. You are the only writer. Specialists return text. You decide what survives into the artifact, what gets posted to the PR, and what gets escalated via request_human_input.

If a ce-* subagent_type listed below is not available in the host's agent list (the compound-engineering plugin isn't installed), skip that specialist and continue. Do not fail the work item on missing agents.$md$
)
ON CONFLICT (app_id, name) DO NOTHING;

INSERT INTO team_roles (team_id, name, description_md, subagent_type, ordinal)
SELECT t.id, r.name, r.description_md, r.subagent_type, r.ordinal
FROM teams t
CROSS JOIN (VALUES
  (
    'correctness',
    'Always dispatch. Reviews for logic errors, edge cases, state-management bugs, error-propagation failures, and intent-vs-implementation mismatches. Prompt with the diff plus the work item description.',
    'ce-correctness-reviewer',
    10
  ),
  (
    'maintainability',
    'Always dispatch. Reviews for premature abstraction, unnecessary indirection, dead code, coupling between unrelated modules, and naming that obscures intent.',
    'ce-maintainability-reviewer',
    20
  ),
  (
    'testing',
    'Always dispatch. Reviews for test coverage gaps, weak assertions, brittle implementation-coupled tests, and missing edge case coverage.',
    'ce-testing-reviewer',
    30
  ),
  (
    'project-standards',
    'Always dispatch. Audits the change against the project''s own CLAUDE.md / AGENTS.md standards: frontmatter rules, naming conventions, cross-platform portability, tool-selection policies.',
    'ce-project-standards-reviewer',
    40
  ),
  (
    'security',
    'Dispatch when the diff touches auth middleware, public endpoints, user input handling, permission checks, anything matching auth|login|session|token|permission in the path. Reviews for exploitable vulnerabilities.',
    'ce-security-reviewer',
    100
  ),
  (
    'data-migrations',
    'Dispatch when the diff touches migration files (packages/*/src/schema/*.sql, db/migrate/*, prisma/migrations/*), schema changes, data transformations, or backfill scripts. Reviews for data integrity and migration safety.',
    'ce-data-migrations-reviewer',
    110
  ),
  (
    'schema-drift',
    'Dispatch alongside data-migrations whenever schema.rb / structure.sql / equivalent canonical schema files change. Detects schema changes that don''t trace to an included migration in the diff.',
    'ce-schema-drift-detector',
    115
  ),
  (
    'performance',
    'Dispatch when the diff touches database queries, loop-heavy data transforms, caching layers, or I/O-intensive paths. Heuristic trigger: >30 LOC added in DB-access or query-builder files, or visible new loops over collections of unknown size.',
    'ce-performance-reviewer',
    120
  ),
  (
    'api-contract',
    'Dispatch when the diff touches API routes, request/response types, serialization, versioning, or exported public type signatures (packages/*/src/lib/types*, top-level index.ts exports). Reviews for breaking contract changes.',
    'ce-api-contract-reviewer',
    130
  ),
  (
    'reliability',
    'Dispatch when the diff touches error handling, retries, circuit breakers, timeouts, health checks, background jobs, or async handlers. Reviews for production reliability and failure modes.',
    'ce-reliability-reviewer',
    140
  ),
  (
    'previous-comments',
    'Dispatch when reviewing a PR that has existing review comments or review threads. Checks whether prior feedback has been addressed in the current diff. Detect via gh pr view <pr_url> --json reviews,comments.',
    'ce-previous-comments-reviewer',
    150
  ),
  (
    'adversarial',
    'Dispatch when the diff is large (>=500 LOC changed) or touches auth, payments, data mutations, or external APIs. Actively constructs failure scenarios to break the implementation rather than checking against known patterns.',
    'ce-adversarial-reviewer',
    160
  )
) AS r(name, description_md, subagent_type, ordinal)
WHERE t.name = 'sapling-code-review' AND t.app_id IS NULL
ON CONFLICT (team_id, name) DO NOTHING;

-- sapling-plan-stress-test ---------------------------------------------------
INSERT INTO teams (name, app_id, description, lead_prompt_md)
VALUES (
  'sapling-plan-stress-test',
  NULL,
  'Default plan stress-test panel — dispatches compound-engineering planning-doc reviewers.',
  $md$You are the lead planner. Your specialists are compound-engineering planning-doc review agents.

For every plan work item you claim with this team attached:

1. Run the planning flow as normal (superpowers:brainstorming, superpowers:writing-plans, or the user-directed equivalent) until the plan document is ready to persist.

2. Before calling create_plan and complete_work, dispatch every specialist in this team's role list in parallel. Each receives the plan body and the work item description. Tell each: "Return findings as a markdown list, max 10 bullets, prioritized by severity. Do not call attach_artifact, complete_work, request_human_input, or any filesystem-writing tool."

3. Aggregate every specialist's findings into one plan_review artifact (attach_artifact kind=plan_review). Body layout: top line "Plan readiness: READY | NEEDS REVISION — <one-line reason>", then a "Must fix before activation" list of blockers, then a collapsible <details> section per reviewer with their full output.

4. If any specialist returns a blocker that you can address by editing the plan, do so before persisting. If a blocker requires a human decision (architectural fork, missing requirement, ambiguous acceptance criteria), call request_human_input with a numbered list of the open questions and exit — do not persist the plan as active with unresolved blockers.

5. Only when no blockers remain, persist the plan with create_plan({ status: 'active', ... }) and complete the work item.

6. You are the only writer. Specialists return text. The artifact's body is your synthesis, not a verbatim concatenation.

If a ce-* subagent_type listed below is not available in the host's agent list (the compound-engineering plugin isn't installed), skip that specialist and continue. Do not fail the work item on missing agents.$md$
)
ON CONFLICT (app_id, name) DO NOTHING;

INSERT INTO team_roles (team_id, name, description_md, subagent_type, ordinal)
SELECT t.id, r.name, r.description_md, r.subagent_type, r.ordinal
FROM teams t
CROSS JOIN (VALUES
  (
    'feasibility',
    'Evaluates whether the proposed technical approach will survive contact with reality — architecture conflicts, dependency gaps, migration risks, implementability.',
    'ce-feasibility-reviewer',
    10
  ),
  (
    'scope-guardian',
    'Reviews for scope alignment and unjustified complexity — challenges unnecessary abstractions, premature frameworks, and scope that exceeds stated goals.',
    'ce-scope-guardian-reviewer',
    20
  ),
  (
    'coherence',
    'Reviews for internal consistency — contradictions between sections, terminology drift, structural issues, and ambiguity where readers would diverge.',
    'ce-coherence-reviewer',
    30
  ),
  (
    'security-lens',
    'Evaluates security gaps at the plan level — auth/authz assumptions, data exposure risks, API surface vulnerabilities, missing threat model elements.',
    'ce-security-lens-reviewer',
    40
  ),
  (
    'design-lens',
    'Reviews for missing design decisions — information architecture, interaction states, user flows, and AI-slop risk.',
    'ce-design-lens-reviewer',
    50
  ),
  (
    'product-lens',
    'Reviews as a senior product leader — challenges premise claims, assesses strategic consequences (trajectory, identity, adoption, opportunity cost), surfaces goal-work misalignment.',
    'ce-product-lens-reviewer',
    60
  ),
  (
    'adversarial-document',
    'Challenges premises, surfaces unstated assumptions, and stress-tests decisions rather than evaluating document quality. Reserve for high-stakes plans (new abstractions, significant architectural decisions, more than 5 requirements).',
    'ce-adversarial-document-reviewer',
    70
  )
) AS r(name, description_md, subagent_type, ordinal)
WHERE t.name = 'sapling-plan-stress-test' AND t.app_id IS NULL
ON CONFLICT (team_id, name) DO NOTHING;

-- Global team_defaults -------------------------------------------------------
-- Per-app defaults still take precedence over these globals at enqueue time.
-- A user who has already set a different global default for review/plan keeps
-- their setting; ON CONFLICT DO NOTHING preserves it.
INSERT INTO team_defaults (app_id, work_type, team_id)
SELECT NULL, 'review'::work_type, id
FROM teams
WHERE name = 'sapling-code-review' AND app_id IS NULL
ON CONFLICT ON CONSTRAINT team_defaults_uniq DO NOTHING;

INSERT INTO team_defaults (app_id, work_type, team_id)
SELECT NULL, 'plan'::work_type, id
FROM teams
WHERE name = 'sapling-plan-stress-test' AND app_id IS NULL
ON CONFLICT ON CONSTRAINT team_defaults_uniq DO NOTHING;
