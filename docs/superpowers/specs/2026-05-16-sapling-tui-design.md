# Sapling TUI — design

**Date:** 2026-05-16
**Status:** proposed
**Owner:** cfa

## Why

Sapling has good MCP plumbing and a working runner, but no live "what's
the queue doing right now" surface. Today, observing running work means
either tailing `data/runner.log`, re-running `/sapling:status` snapshots,
or watching multiple agents' stdout interleave into the same `make
runner` terminal. None of that is a good experience when 2+ work items
run in parallel.

The desired outcome is **one terminal UI** that shows queue state live
and lets the user jump into any running Claude Code session with a
single keystroke (and back with the standard tmux prefix). The user
explicitly likes the Claude Code "agents view" feel and wants that for
Sapling work items.

## What we're building

1. A new `packages/tui/` workspace that ships a `sapling-tui` binary —
   an Ink-based dashboard that polls the Sapling MCP server and renders
   work items grouped by status, with detail pane, filtering, and a few
   action keys (unblock / retry / cancel / re-enqueue input).

2. A tmux-backed spawn mode in `packages/runner/` so each spawned agent
   gets its own tmux window. The TUI uses tmux's `switch-client` to
   "attach" into a live agent and the standard tmux prefix to come back.

3. A small change to the `/sapling:work` skill: immediately after
   `claim_next_work` succeeds, rename the current tmux window to
   `work-<id>` so the TUI can correlate windows with work rows by name.

4. A new `make tui` target that bootstraps the `sapling` tmux session
   with the runner in one window and the TUI in another, then attaches.

## Non-goals (phase 1)

- No new MCP tools. The TUI uses what's already exposed (`list_work`,
  `get_work`, `list_projects`, `list_artifacts`, `unblock_work`,
  `retry_work`, `cancel_work`, `provide_human_input`).
- No new `work` columns. The work-item ↔ tmux-window mapping is
  recovered by window name (`work-<id>`), not by a stored field.
- No embedded PTY in the TUI. Claude Code stays a full tmux window; the
  TUI does not host a vt100 emulator.
- No web UI, no notification routing changes.
- No support for non-tmux multiplexers (zellij, screen). Tmux only.
- No headless / launchd runner mode. The runner remains a foreground
  process started by the user.

## Architecture

```
                ┌────────────────────────────────────────┐
                │  tmux session: "sapling"               │
                │                                        │
   user ──attach┤   window: runner   ← make runner       │
                │   window: tui      ← sapling-tui (Ink) │
                │   window: work-42  ← claude /work      │
                │   window: work-43  ← claude /work      │
                └────────────┬───────────────────────────┘
                             │
                             │ MCP (HTTP)
                             ▼
                  ┌─────────────────────┐
                  │  sapling mcp-server │
                  └─────────────────────┘
```

The TUI is a pure reader/actor against the MCP server. It does **not**
talk to the runner directly. It learns "which windows are live" by
shelling out to `tmux list-windows -t sapling -F '#{window_id}
#{window_name}'` once per poll and joining by window name.

## Detailed design

### 1. `packages/mcp-client/` (extracted shared client)

Today `packages/runner/src/mcp_client.ts` is private to the runner. The
TUI needs the same client, so we extract it.

- New workspace `packages/mcp-client/` containing the HTTP MCP client,
  type definitions for the tools the runner and TUI consume, and tests
  for the client itself (move from `packages/runner/test/`).
- `packages/runner/` and `packages/tui/` both depend on
  `@sapling/mcp-client` via the workspace protocol.
- No behavioral change. Strict refactor.

### 2. Runner: tmux spawn mode

Add `spawnAgentTmux` alongside `spawnAgent` in `packages/runner/src/`.
Selection is automatic: if `process.env.TMUX` is set **and** the new
runner-config key `use_tmux` is true (default true when running inside
tmux, false otherwise), use the tmux spawner; else fall back to current
behavior.

Spawn shape:

```bash
tmux new-window -d -P -F '#{window_id}' \
  -t "$SAPLING_TMUX_SESSION" \
  -n "spawn-<seq>" \
  bash -lc '<agent_command>'
```

Notes:

- `-d` keeps the runner's window focused; new windows open in the
  background. The TUI is what users use to navigate to them.
- `-P -F '#{window_id}'` prints the new window's stable id (e.g. `@7`),
  which we store on the `SpawnedAgent` so the runner can `kill-window`
  it on shutdown. Replaces `process.kill(-pid)`.
- `spawn-<seq>` is a temporary name; the work skill renames it to
  `work-<id>` after claim. If the claim returns `null` (no pending
  work), the window survives for ~5s of idle output then exits — same
  as today's no-tmux path.
- The `bash -lc` wrapper stays identical to today's spawn, so
  `agent_command` continues to be shell-compatible.
- Env injection: in addition to `SAPLING_RUNNER=1`, set
  `SAPLING_TMUX_SESSION=<name>` so the work skill knows what session
  it's in without re-querying tmux.

New runner-config keys (added in `packages/mcp-server/src/schema/`):

- `use_tmux: boolean` (default `true` — auto-disabled if `$TMUX` is
  unset at runner startup, with a warning).
- `tmux_session_name: string` (default `"sapling"`).

Shutdown change: `SpawnedAgent.kill` runs `tmux kill-window -t
<window_id>` for tmux-spawned children instead of `process.kill(-pid)`.

### 3. `/sapling:work` skill: rename on claim

After `claim_next_work` returns a non-null work item, the skill runs:

```bash
if [ -n "$SAPLING_TMUX_SESSION" ] && [ -n "$TMUX_PANE" ]; then
  tmux rename-window -t "$TMUX_PANE" "work-<id>"
fi
```

This is a single command, gated on env, so it's a no-op outside tmux —
keeping the skill backward-compatible with non-tmux runs (CI, headless).

Bumps `packages/claude-plugin/.claude-plugin/plugin.json` minor version
per CLAUDE.md rules (observable agent behavior change).

### 4. `packages/tui/` — the TUI itself

**Stack:** Ink (React renderer for terminal), TypeScript. Same Node
toolchain as the rest of the repo. No extra build pipeline beyond
existing `tsc`.

**Layout (default):**

```
┌─ Sapling ──────────────────────────────────────────────────────────┐
│ pending (3)               ┃ #42  app=iris  type=code               │
│   #42 build search        ┃ status: claimed (00:02:13)             │
│   #45 fix import          ┃ branch: cfa/sapling-work-42            │
│   #51 retry migration     ┃ tmux:  sapling:work-42                 │
│                           ┃                                        │
│ claimed (1)               ┃ prompt:                                │
│ ▸ #42 build search        ┃   Build a search index for…            │
│                           ┃                                        │
│ awaiting_input (1)        ┃ latest artifact (plan #12):            │
│   #38 ask user…           ┃   - investigate Postgres FTS           │
│                           ┃   - decide tokenizer                   │
│ blocked (0)               ┃   …                                    │
│ failed (1)                ┃                                        │
│   #29 dod fix loop        ┃                                        │
├───────────────────────────┴────────────────────────────────────────┤
│ ↑↓ nav  → attach  u unblock  r retry  c cancel  i input  q quit    │
└────────────────────────────────────────────────────────────────────┘
```

**Keys (phase 1):**

- `↑ / ↓` — move within the current status group
- `j / k` — same
- `tab / shift-tab` — switch status group
- `→ / enter` — `tmux switch-client -t sapling:work-<id>` (only enabled
  when status is `claimed` and a matching window exists)
- `u` — `unblock_work` (prompts for note)
- `r` — `retry_work` (prompts for note)
- `c` — `cancel_work` (confirm)
- `i` — `provide_human_input` (multi-line editor pane) when status is
  `awaiting_input`
- `/` — filter by app or substring
- `?` — help overlay
- `q` — quit
- `g` — re-poll immediately

**Polling:**

- `list_work` every 1s while focused, every 5s when blurred (Ink can
  detect this via stdin focus events, fall back to "always 1s").
- `list_projects` every 5s.
- `tmux list-windows -t <session> -F '#{window_id} #{window_name}'`
  every 1s, joined to work rows by `work-<id>`.

**Detail pane fetches:**

- `get_work(id)` and `list_artifacts({ work_id: id, limit: 5 })` on
  selection change, with a 500ms debounce so rapid `↑↓` doesn't thrash.

**Telemetry / errors:**

- Errors surface in a one-line status bar; full error in `?` overlay.
- The TUI never crashes on MCP failure — it shows a red banner and
  keeps polling.

### 5. `make tui` target

```make
tui:
	tmux new-session -d -s sapling -n runner 'make runner' || true
	tmux new-window -t sapling -n tui 'pnpm --filter sapling-tui dev'
	tmux select-window -t sapling:tui
	tmux attach -t sapling
```

The `|| true` after `new-session` means re-running `make tui` while a
session exists just attaches; it doesn't double-start the runner.

`make runner` remains unchanged as the no-tmux escape hatch.

## Migration / rollout

The change is opt-in by behavior:

- Users who keep running `make runner` outside tmux see no change. The
  spawner falls back to the current `bash -lc` shape.
- Users who run `make tui` get the new flow.
- The `/sapling:work` rename is no-op outside tmux.

No database migration is required.

## Testing

**Runner:**

- Unit-test `spawnAgentTmux` with a mock that captures the `tmux`
  argv. Existing `spawn.test.ts` pattern.
- Integration test: when `$TMUX` is unset, the runner picks
  `spawnAgent`; when it's set, it picks `spawnAgentTmux`.

**MCP-client extraction:**

- Existing runner tests for the client move with it. No new tests.

**TUI:**

- `ink-testing-library` for rendering snapshots of each status group
  and the detail pane.
- A fake MCP client interface to drive state transitions
  (pending → claimed → complete; awaiting_input cycle).
- A fake tmux interface (function returning a list of windows) so the
  attach-enabled logic is testable without a real tmux.
- Manual smoke test checklist in the PR description.

**Skill:**

- Manual verification: open tmux, run `make tui`, enqueue a work item,
  watch the spawned window's name change from `spawn-<seq>` to
  `work-<id>` after claim.

## Open questions

1. **Window names on long-running work.** If a work item is `claimed`
   for hours, the tmux window stays named `work-<id>` indefinitely. Do
   we want to also append a short status hint (`work-42:running`)?
   Default for phase 1: no — keep names stable so `switch-client -t
sapling:work-42` is predictable. Revisit if it feels lossy in use.
2. **Detail pane: artifact rendering.** Phase 1 shows the artifact
   title list with the first ~10 lines of the most recent artifact
   body. Full body rendering (markdown, syntax highlighting) is out of
   scope.
3. **Should the TUI also surface plans / projects views?** Phase 1 is
   work-items only. Tabbed views for plans and projects are a phase-2
   addition once the work view feels right.

## Plan of execution

Sequence, smallest viable steps:

1. Extract `packages/mcp-client/`. Pure refactor. PR #1.
2. Add `spawnAgentTmux` and the `use_tmux` config keys to the runner;
   keep default behavior identical when `$TMUX` is unset. PR #2.
3. Update `/sapling:work` to rename the window after claim; bump
   plugin minor version. PR #3.
4. Scaffold `packages/tui/` with the layout shell and read-only views
   (no actions yet). PR #4.
5. Add the action keys (`u/r/c/i`) and `make tui` target. PR #5.

Each PR is independently revertable; the TUI work doesn't block until
PR #2 lands.
