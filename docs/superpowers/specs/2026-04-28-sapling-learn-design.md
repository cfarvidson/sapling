# Sapling — `/sapling:learn` Command

**Status:** Draft for implementation
**Date:** 2026-04-28
**Author:** Carl-Fredrik Arvidson (with brainstorming assistant)

## Summary

`/sapling:learn` is a Claude Code slash command that researches a set of code repos for an app, then populates Sapling's product knowledge: it creates services, fills in `tech_stack` and `depends_on`, and attaches a markdown architecture summary. All work happens in the current Claude session via existing MCP tools — no new server-side surface.

## Goals

1. **Bootstrap product knowledge from real repos in one command.** A new user with N repos on disk can populate Sapling without typing `register_service` N times.
2. **Stay in Sapling's existing philosophy.** The MCP server stays thin; the calling Claude session does the analysis and persists results via existing tools.
3. **Be safe to re-run.** Manual edits to service metadata are preserved on subsequent invocations.
4. **Produce an artifact the agent can consume later.** Architecture summaries become first-class artifacts retrievable via `/sapling:context`.

## Non-Goals (v1)

- Cloning remote repos. Local paths only.
- Language-specific AST parsing. Manifest reads + greps only.
- Cross-app discovery. Each invocation is scoped to one app.
- Diffing previous runs / showing what changed.
- New MCP tools. The skill uses only existing tools.

## Architecture

A single skill file, `packages/claude-plugin/.claude/skills/sapling-learn/SKILL.md`, that the calling Claude session executes. The skill calls existing MCP tools:

```
                ┌────────────────────────────────────┐
                │ Claude Code (you)                  │
                │                                    │
                │   /sapling:learn checkout ~/code/* │
                │                                    │
                │   ┌─────────────────────────────┐  │
                │   │ sapling-learn skill         │  │
                │   │  - parse args               │  │
                │   │  - per repo: read + grep    │  │
                │   │  - draft summary            │  │
                │   └────────────┬────────────────┘  │
                └────────────────┼───────────────────┘
                                 │
                                 ▼
            ┌──────────────────────────────────┐
            │ Sapling MCP (already shipped)    │
            │  - register_app                  │
            │  - list_services                 │
            │  - register_service              │
            │  - update_service                │
            │  - attach_artifact               │
            └──────────────────────────────────┘
```

No code changes to `packages/mcp-server/`. One new directory: `packages/claude-plugin/.claude/skills/sapling-learn/`.

## Invocation Forms

| Form                                       | Behavior                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sapling:learn <app> <path1> [path2 ...]` | Use given repo paths as services. App is created if missing.                                                                                                    |
| `/sapling:learn <app> <single-dir>`        | Single arg. If the dir contains `.git/`, treat as one service. Otherwise scan immediate children for `.git/` subdirs; each match is a service.                  |
| `/sapling:learn <app>`                     | No paths: read existing `services` for the app, use their `repo_url` if it points to a local path (`file://` or absolute). Fail with a clear message otherwise. |

## Control Flow

1. Parse args → `{ appName, repoPaths[] }`.
2. `mcp__sapling__list_apps`. If `appName` not present, `mcp__sapling__register_app({ name: appName })`.
3. For each `repoPath`:
   1. Verify it exists and contains `.git/`. Skip with a warning otherwise (don't fail the whole run).
   2. Run the detection pass (see below). Emit a JSON observation:
      ```json
      {
        "name": "checkout-api",
        "repo_url": "git@github.com:foo/checkout-api.git",
        "tech_stack": ["typescript", "node", "express", "postgres"],
        "depends_on": ["auth"],
        "description": "Cart and checkout REST API.",
        "conventions": "/Users/cfa/code/checkout-api/CLAUDE.md"
      }
      ```
   3. `mcp__sapling__list_services({ app_name: appName })` then look for matching `name`.
      - If absent → `mcp__sapling__register_service` with detected fields.
      - If present → `mcp__sapling__update_service` applying merge semantics (see below).
4. After all services processed, draft a single architecture summary covering the whole app.
5. For each service in the app, `mcp__sapling__attach_artifact({ kind: 'architecture', service_id, body_markdown })`. This means `/sapling:context <any-service>` surfaces the architecture artifact for that app.
6. Print a summary to the user: services created/updated/skipped, artifact ids.

## Detection Rules

| Output field   | Signals                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Directory name, lowercased and sanitized (`[^a-z0-9-]` → `-`).                                                                                                                                                                                                                                                                                                                                                                              |
| `repo_url`     | `git -C <path> remote get-url origin` if it succeeds, else `file://<absolute-path>`.                                                                                                                                                                                                                                                                                                                                                        |
| `tech_stack[]` | Manifest detection. `package.json` → `typescript`/`node` plus framework keys (react, next, express, fastify, hono…). `pyproject.toml`/`requirements.txt` → `python` plus framework. `Gemfile` → `ruby`/`rails`. `go.mod` → `go`. `Cargo.toml` → `rust`. Plus DB drivers in deps (`pg` → `postgres`, `mysql2` → `mysql`, `redis` → `redis`, etc.). De-duped.                                                                                 |
| `depends_on[]` | Heuristics in priority order: (1) shared internal packages from monorepo manifests (`workspaces` in `package.json`, `pnpm-workspace.yaml`, sibling crate paths in `Cargo.toml`); (2) HTTP/RPC base URLs grepped from source that resolve to other service names in this app; (3) message-bus topic names if they overlap with service names. **Result is a list of service NAMES** (strings), not ids — the schema stores them as `TEXT[]`. |
| `description`  | One-line summary the LLM writes after reading the README and `package.json` description.                                                                                                                                                                                                                                                                                                                                                    |
| `conventions`  | If `CLAUDE.md` or `AGENTS.md` exists at repo root, store its absolute path. Else null.                                                                                                                                                                                                                                                                                                                                                      |

## Merge Semantics on Re-run

Applied when the service already exists:

- **Lists** (`tech_stack`, `depends_on`): UNION with existing values. Never lose user-added entries.
- **Scalars** (`description`, `conventions`, `repo_url`): only fill in if the existing value is null/empty. Don't clobber user edits.
- **Architecture artifact**: always re-create (a new row). Don't try to merge prose. Old artifacts are kept; the schema allows multiple `kind='architecture'` artifacts per service. User can prune via `psql` if cruft accumulates.

## Architecture Artifact Format

Single markdown body, ~200–500 words:

```markdown
# Architecture — <app name>

_Generated by /sapling:learn on <YYYY-MM-DD>_

## Services

- **<service-1>** (<tech_stack joined>) — <description> — repo: <repo_url>
- **<service-2>** ...

## Dependencies

- <service-a> → <service-b> (<reason: shared package / HTTP / topic>)
- ...

## Entry points

- <service-x> exposes HTTP routes on port <N> (if grep'd from source)
- <service-y> consumes messages from topic <T>

## Notes

- <anything noteworthy: orphans, circular deps, unfamiliar tech, open questions>
```

## Error Handling

- **Path missing or no `.git/`**: skip with a warning in the final summary; don't fail the whole run.
- **App doesn't exist and no description provided**: create the app with empty description; user can update later.
- **MCP tool returns an error**: surface it inline in the run output and continue with the next repo. Do not retry.
- **No paths given AND no existing services**: fail with `"Cannot infer repos for app '<name>': no services registered. Pass repo paths explicitly."`
- **A service already exists with a different `repo_url` than what was just detected**: leave the existing `repo_url` untouched (per scalar merge rules) but include a note in the run output: `"warning: <service> repo_url differs (db=<X>, detected=<Y>); not changed"`.

## Open Questions / Deferred

- **Auto-clone for remote repo_urls.** v1 fails fast; v2 could clone to a tmp dir.
- **Phase decomposition for very large apps.** If a 12-repo run hits context limits, the skill could enqueue per-repo `plan` tasks instead. Defer until proven needed.
- **Detection-rule customization.** Users may want to add or remove signal sources. v1 hard-codes the rules in the SKILL.md; v2 could read a `.sapling/learn.yml`.
- **Pruning old architecture artifacts.** Possible future tool: `prune_artifacts(kind, service_id, keep_last=N)`.
