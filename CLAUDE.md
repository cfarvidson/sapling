# Sapling — Claude instructions

## Keep SPEC.md in sync

`SPEC.md` at the repo root is the living, top-level specification for Sapling. Treat it as part of the code, not as documentation that someone else maintains.

When you make a change that affects any of the following, update `SPEC.md` in the **same commit / PR**:

- The MCP tool surface (adding, removing, renaming a tool in `packages/mcp-server/src/tools/`, or changing the README's advertised tool count).
- The slash-command surface in `packages/claude-plugin/skills/`.
- The data model (a new migration in `packages/mcp-server/src/schema/`, a new enum value, a new table, or a column with semantic meaning).
- The work-item lifecycle (new status, new transition, new reaper behavior).
- Runtime topology (new process, new port, new transport, new container).
- Runner configuration keys or their defaults.
- Stated goals or non-goals.

If you are unsure whether a change qualifies, update `SPEC.md` — over-updating costs nothing; drift costs trust.

Pure refactors, formatting, dependency bumps, or test-only changes do **not** require a `SPEC.md` update.

When SPEC.md and a dated design doc in `docs/superpowers/specs/` disagree, SPEC.md wins for the _current_ shape of the system; the design doc remains the historical record.

## Bump the plugin version when skills change

`packages/claude-plugin/.claude-plugin/plugin.json` carries the `version` that downstream installs of the Sapling Claude Code plugin pin against. Skills do not have per-file versions — they ship under the plugin version.

When a commit / PR landing on `main` changes anything under `packages/claude-plugin/skills/` or `packages/claude-plugin/.claude-plugin/`, bump `version` in `plugin.json` in the **same commit / PR**, using semver:

- **Patch** (`0.5.0` → `0.5.1`) — typo fixes, wording tweaks, clarifications that don't change the agent's observable behavior.
- **Minor** (`0.5.0` → `0.6.0`) — new skill, new step in an existing skill, new required output structure, new binding rule, or any change a downstream user would notice in agent behavior.
- **Major** (`0.x` → `1.0`, `1.x` → `2.0`) — removed/renamed slash command, removed step that callers depended on, breaking change to artifact shape.

Pure changes outside the plugin (mcp-server, runner, docs, tests) do **not** require a plugin version bump.
