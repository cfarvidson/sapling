# `/sapling:learn` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/sapling:learn` slash command that researches a set of code repos for an app and populates Sapling's product knowledge (services, tech_stack, depends_on, architecture artifact) using only existing MCP tools.

**Architecture:** A single SKILL.md file under `packages/claude-plugin/.claude/skills/sapling-learn/`. The skill is markdown prose that instructs the calling Claude session to: parse args, inspect each repo on disk (manifests, README, greps), then call the existing Sapling MCP tools (`register_app`, `list_services`, `register_service`, `update_service`, `attach_artifact`, `list_apps`) to persist findings. **No code changes to `packages/mcp-server/`.**

**Tech Stack:**

- Markdown SKILL.md (no compile step)
- Existing Sapling MCP server (already shipped)
- Existing Claude Code plugin structure under `packages/claude-plugin/.claude/skills/`

---

## File Structure

```
packages/claude-plugin/.claude/skills/sapling-learn/
└── SKILL.md                         # the entire feature
```

Updates to existing files:

- `packages/claude-plugin/README.md` — add `/sapling:learn` to the commands list
- `README.md` (root) — add `/sapling:learn` to the slash commands list
- `docs/superpowers/specs/2026-04-28-sapling-learn-design.md` — already committed; no edits

**Files NOT touched:** anything under `packages/mcp-server/`, any tests, any Dockerfile, the schema. This is a pure plugin/skill addition.

---

## Conventions

- **Branching:** none — work directly on `main` (greenfield repo, single user, matches the Sapling project's existing convention).
- **Before each commit:** `pnpm format` (per global instruction). No lint step needed — there's no TypeScript in this feature.
- **Commit messages:** Conventional Commits.
- **Verification:** there is no automated test for SKILL.md prose. Verification is a manual smoke test (Task 3) — run the command against a real local repo set and check the resulting Sapling state via `psql`.

---

## Task 1: Write the `sapling-learn` SKILL.md

**Files:**

- Create: `packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p packages/claude-plugin/.claude/skills/sapling-learn
```

- [ ] **Step 2: Write SKILL.md**

Create `packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md` with EXACTLY this content:

````markdown
---
name: sapling-learn
description: Research code repos for an app and populate Sapling with services, dependencies, and an architecture summary. Triggers on /sapling:learn.
---

# /sapling:learn

Research a set of code repos for an app and populate Sapling's product knowledge: services, tech_stack, depends_on, and a markdown architecture summary attached as an artifact.

This skill does NOT add new MCP tools. It uses these existing Sapling MCP tools:

- `mcp__sapling__list_apps`
- `mcp__sapling__register_app`
- `mcp__sapling__list_services`
- `mcp__sapling__register_service`
- `mcp__sapling__update_service`
- `mcp__sapling__attach_artifact`

## Invocation Forms

Parse the user's arguments to derive `appName` and `repoPaths[]`:

| Form                                       | Behavior                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sapling:learn <app> <path1> [path2 ...]` | Use the given repo paths as services.                                                                                                                                                                                |
| `/sapling:learn <app> <single-dir>`        | If `<single-dir>` contains `.git/`, treat as one service. Otherwise scan immediate children of `<single-dir>` for `.git/` subdirs; each match is a service.                                                          |
| `/sapling:learn <app>`                     | No paths. Read existing services for the app via `list_services`; use each `repo_url` if it points to a local path (`file://...` or absolute filesystem path). Fail with a clear message if nothing usable is found. |

If parsing yields no `appName`, tell the user: "Usage: `/sapling:learn <app> [<path1> ...]`. Example: `/sapling:learn checkout ~/code/checkout-api ~/code/checkout-web`." and stop.

## Steps

### 1. Resolve the app

1. Call `mcp__sapling__list_apps` with `{}`.
2. If `<appName>` is not in the result, call `mcp__sapling__register_app` with `{ name: appName }`. Capture the returned `id`.
3. Otherwise grab the existing app's `id` from the list.

### 2. Resolve the repo paths

Apply the table above to derive `repoPaths[]`. For form 3 (no args), call `mcp__sapling__list_services({ app_name: appName })` and collect each service's `repo_url` IF it is either a `file://` URL or an absolute filesystem path. Strip the `file://` prefix.

Validate each path:

- Must exist on disk.
- Must contain a `.git` entry (file or directory).

If a path fails either check, record a warning (`"<path>: skipped — not a git repo"`) and continue. Don't abort.

### 3. Detection pass — per repo

For each valid `repoPath`, produce a JSON observation:

```json
{
  "name": "<sanitized directory name>",
  "repo_url": "<remote URL or file://...>",
  "tech_stack": ["..."],
  "depends_on": ["..."],
  "description": "<one line>",
  "conventions": "<absolute path to CLAUDE.md/AGENTS.md or null>"
}
```

#### name

Take the basename of `repoPath`. Lowercase it. Replace any character matching `[^a-z0-9-]` with `-`. Collapse runs of `-`. Trim leading/trailing `-`.

#### repo_url

Run `git -C <repoPath> remote get-url origin`. If it succeeds and prints a non-empty value, use it. Otherwise use `file://<absolute repoPath>`.

#### tech_stack

Look for these manifests at the repo root and add the corresponding tags:

- `package.json` → add `node`, `typescript` (if `tsconfig.json` exists or `typescript` is in deps), and any of `react`, `next`, `express`, `fastify`, `hono`, `nestjs`, `vue`, `svelte`, `astro` if present in deps.
- `pyproject.toml` or `requirements.txt` → add `python`, plus any of `django`, `flask`, `fastapi` from deps.
- `Gemfile` → add `ruby`, plus `rails` if `rails` gem is listed.
- `go.mod` → add `go`.
- `Cargo.toml` → add `rust`.
- `pom.xml` or `build.gradle` → add `java`/`kotlin` accordingly.
- `composer.json` → add `php`, plus `laravel`/`symfony` if found.

Also scan deps for DB/queue drivers and add tags:

- `pg`, `psycopg`, `psycopg2`, `psycopg3`, `pq`, `sqlx` → `postgres`
- `mysql`, `mysql2`, `pymysql` → `mysql`
- `redis`, `ioredis`, `rb-redis` → `redis`
- `mongodb`, `mongoose`, `pymongo` → `mongodb`
- `kafkajs`, `confluent-kafka`, `sarama` → `kafka`
- `amqplib`, `pika` → `rabbitmq`

De-duplicate the resulting list. Lower-case all entries.

#### depends_on

This is a list of OTHER service names within this app. Use these signals, in order:

1. **Workspace siblings.** If the repo is part of a monorepo manifest (`workspaces` field in `package.json`, `pnpm-workspace.yaml`, or sibling crates in `Cargo.toml`), list the sibling package names that match other detected services in this app.
2. **Internal HTTP base URLs.** Grep source files (excluding `node_modules`, `dist`, `build`, `.git`, `__pycache__`, `target`) for strings of the form `http(s)?://<word>(:port)?` where `<word>` matches the name of another service in this app (case-insensitive).
3. **Message-bus topic names.** If you see a topic literal that exactly matches another service's name, count it.

The result is a list of service names (strings). De-duplicate. Empty list is fine.

#### description

Read up to the first 200 lines of `README.md` (or `README`, `Readme.md`, `readme.md`). Read `package.json`'s `"description"` field if present. Synthesize a single-sentence (max ~120 chars) description. If you have nothing to go on, set this to null.

#### conventions

Check for `CLAUDE.md` or `AGENTS.md` at the repo root (in that priority order). If found, store the absolute path as a string. Otherwise null.

### 4. Persist findings — per repo

For each observation:

1. Look up the existing service in this app by `name`. Use the `list_services({ app_name })` result fetched earlier (or fetch fresh).
2. **If absent:** call `mcp__sapling__register_service` with the observation fields. Pass `null`/omit for any null detection fields.
3. **If present:** apply MERGE SEMANTICS and call `mcp__sapling__update_service`:
   - **`tech_stack`** and **`depends_on`**: UNION the detected list with the existing list. De-duplicate.
   - **`description`**, **`conventions`**, **`repo_url`**: only set if the existing value is null or empty string. Do NOT clobber a non-empty value.
   - If the existing `repo_url` differs from the detected `repo_url`, do NOT change it; record a warning: `"warning: <name> repo_url differs (db=<existing>, detected=<new>); not changed"`.
   - Build the patch object with only the fields you actually want to update; pass `id` and the changed fields. Skip the call entirely if there are no fields to change.

Capture the resulting service id for the next step.

### 5. Architecture summary

Once all repos are processed, draft a single markdown body covering the whole app. Use this exact template:

```markdown
# Architecture — <appName>

_Generated by /sapling:learn on <YYYY-MM-DD>_

## Services

- **<service-1>** (<tech_stack joined with ", ">) — <description or "no description"> — repo: <repo_url>
- **<service-2>** ...

## Dependencies

- <service-a> → <service-b> (<reason: "shared package" / "HTTP" / "topic">)
- ...
  (omit this section if there are no detected dependencies)

## Entry points

- <service-x> exposes HTTP routes on port <N>
- <service-y> consumes messages from topic <T>
  (omit this section if you found nothing concrete)

## Notes

- <orphans, circular deps, unfamiliar tech, open questions>
  (omit if you have nothing to add)
```

For each service id captured in step 4, call `mcp__sapling__attach_artifact` with:

```json
{
  "kind": "architecture",
  "title": "Architecture — <appName>",
  "body_markdown": "<the rendered markdown above>",
  "service_id": <id>
}
```

This means `/sapling:context <any-service-in-this-app>` will surface the architecture artifact for that app.

### 6. Final summary to the user

Print a concise report:

```
/sapling:learn <appName>
  ✓ created  <name> (id=<id>)  tech_stack=[...]  depends_on=[...]
  ✓ updated  <name> (id=<id>)  added=[...]
  ⚠ skipped  <path> — <reason>
  ⚠ warning  <name> repo_url differs (db=..., detected=...); not changed

  Attached architecture artifact (id=<id1>, id=<id2>, ...) to <N> services.
```

End with: "Run `/sapling:context <service>` to load the new context into a session, or `/sapling:plan <desc>` to queue planning work."

## Failure handling

If an MCP call returns an error, surface it inline (`"✗ error  <name>: <message>"`) and continue to the next repo. Do not retry. Do not abort the run.

If form 3 (no paths) is used and no usable local `repo_url` is found, fail before doing any work:

> Cannot infer repos for app '<appName>': no services have a local repo_url. Pass repo paths explicitly, e.g. `/sapling:learn <appName> ~/code/<repo1> ~/code/<repo2>`.
````

- [ ] **Step 3: Verify the file is well-formed**

```bash
test -f packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md && head -5 packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md
```

Expected: prints the frontmatter (`---`, `name: sapling-learn`, `description: ...`, `---`).

- [ ] **Step 4: Format**

```bash
pnpm format
```

Expected: prettier reformats markdown if needed; no errors.

- [ ] **Step 5: Commit**

The `.claude/` directory may be in a global gitignore, so use `-f` (matches the Task 20 pattern from the original Sapling build).

```bash
git add -f packages/claude-plugin/.claude/skills/sapling-learn
git commit -m "feat(plugin): add /sapling:learn skill for repo research and population"
```

Verify:

```bash
git log --oneline -3
```

---

## Task 2: Update READMEs to advertise the new command

**Files:**

- Modify: `packages/claude-plugin/README.md`
- Modify: `README.md` (repo root)

- [ ] **Step 1: Update plugin README**

Open `packages/claude-plugin/README.md`. Find the section that lists the slash commands (it currently lists `/sapling:work`, `/sapling:plan`, `/sapling:enqueue`, `/sapling:status`, `/sapling:context`). Add ONE new bullet immediately after the existing list:

```markdown
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact
```

- [ ] **Step 2: Update root README**

Open `README.md` at the repo root. Find the same slash commands list (under "Copy `packages/claude-plugin/.claude/skills/` into your project's `.claude/skills/` directory to install the slash commands:"). Add the same bullet immediately after the existing list:

```markdown
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact
```

- [ ] **Step 3: Format**

```bash
pnpm format
```

- [ ] **Step 4: Commit**

```bash
git add packages/claude-plugin/README.md README.md
git commit -m "docs: advertise /sapling:learn in READMEs"
```

Verify:

```bash
git log --oneline -3
```

---

## Task 3: Manual smoke test (verification gate before declaring done)

There is no automated test for SKILL.md prose. The verification step is a manual end-to-end run that confirms the skill drives the right MCP behavior.

This task does NOT create or commit anything. It documents the steps the implementer must perform interactively to confirm the skill works.

**Files:** none.

- [ ] **Step 1: Bring up the Sapling stack**

```bash
make up
sleep 5
curl -sf http://127.0.0.1:3333/health
```

Expected: `{"ok":true,"db":"up"}`.

- [ ] **Step 2: Pick a small set of test repos**

Identify two or three local repo directories you actually have on disk. Each must have `.git/`. They don't need to be related to each other — for the smoke test we just want to see the skill correctly populate apps, services, and an artifact.

If you don't have a convenient set, you can scaffold throwaway repos:

```bash
mkdir -p /tmp/saplingtest/{api,web} && \
  (cd /tmp/saplingtest/api && git init -q && echo '{"name":"api","dependencies":{"express":"*","pg":"*"}}' > package.json && git add . && git commit -qm init) && \
  (cd /tmp/saplingtest/web && git init -q && echo '{"name":"web","dependencies":{"react":"*","next":"*"}}' > package.json && git add . && git commit -qm init)
```

- [ ] **Step 3: Install the skill into the project**

The skill must be present in a `.claude/skills/` directory that the running Claude Code session loads. The exact install path depends on your Claude Code setup; for local testing the simplest option is to symlink the skill into your project's `.claude/skills/`:

```bash
mkdir -p .claude/skills
ln -sfn "$PWD/packages/claude-plugin/.claude/skills/sapling-learn" .claude/skills/sapling-learn
```

Reload Claude Code if it's already running so it picks up the new skill.

- [ ] **Step 4: Run the command**

In Claude Code, with the Sapling MCP connected:

```
/sapling:learn smoketest /tmp/saplingtest/api /tmp/saplingtest/web
```

Expected output (paraphrased):

- App `smoketest` created (or already existed).
- Service `api` created with `tech_stack` containing at minimum `node` and `postgres`.
- Service `web` created with `tech_stack` containing at minimum `node`, `react`, `next`.
- An `architecture` artifact attached to both services.
- Final summary lists 2 services created, 0 skipped.

- [ ] **Step 5: Verify the database state**

```bash
make psql -- -c "SELECT name, tech_stack FROM services WHERE app_id = (SELECT id FROM apps WHERE name='smoketest') ORDER BY name;"
make psql -- -c "SELECT id, kind, title, service_id FROM artifacts WHERE kind='architecture' ORDER BY id DESC LIMIT 5;"
```

Note: if `make psql` doesn't accept extra args in your setup, drop into psql interactively (`make psql`) and run the SELECTs there.

Expected:

- Two rows for the services with reasonable `tech_stack` arrays.
- At least two `architecture` artifacts (one per service), with titles starting `Architecture — smoketest`.

- [ ] **Step 6: Re-run to verify merge semantics**

Run the same command a second time:

```
/sapling:learn smoketest /tmp/saplingtest/api /tmp/saplingtest/web
```

Expected:

- Both services reported as `updated` (not `created`).
- `tech_stack` and `depends_on` unchanged (UNION with itself is a no-op).
- TWO new `architecture` artifacts attached (one per service); the previous ones are preserved.

Then manually edit one service to test scalar preservation:

```bash
make psql -- -c "UPDATE services SET description='hand-written description' WHERE name='api' AND app_id=(SELECT id FROM apps WHERE name='smoketest');"
```

Run `/sapling:learn smoketest` (no paths — should pick up `repo_url` from db). Expected: `description='hand-written description'` is preserved.

- [ ] **Step 7: Tear down**

```bash
make down
rm -rf /tmp/saplingtest .claude/skills/sapling-learn
```

- [ ] **Step 8: Document smoke-test result**

If everything passed, declare the feature done. If anything was off, file the discrepancy as a follow-up before claiming complete.

---

## Done

After Task 3 passes:

- One new SKILL.md at `packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md`.
- READMEs advertise `/sapling:learn`.
- Smoke-tested end-to-end against the running Sapling stack.

The MCP server is unchanged. No new tools, no new tests under `packages/mcp-server/`.
