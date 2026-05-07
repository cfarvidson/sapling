# Runner logging: split file and stdout

**Date:** 2026-05-07
**Status:** Approved, ready for plan

## Problem

`make runner` currently prints a JSON line on every tick (default ~30s), even when the tick was a no-op (`reaped:0,spawned:0`). The terminal becomes a wall of identical lines, drowning out the events that actually matter (spawns, reaps, errors, shutdown). There is also no persistent log — once the terminal scrollback rolls, the history is gone.

## Goals

- Quiet stdout: only show events that mean something happened.
- Persistent file log: full event stream, JSON, greppable / jq-friendly.
- Minimal change. No new MCP tools, no new DB config keys, no rotation, no log shipper.

## Non-goals

- Log rotation. The default rate is ~280 KB/day; truncate manually if needed.
- A `make runner-logs` tail target. `tail -f data/runner.log | jq` is one keystroke.
- A status / inspection command. Out of scope; revisit if needed.
- Plugin version bump. No skills change.

## Design

### Two channels

- **File** (`./data/runner.log`, append-only): every event the runner currently logs, in the same JSON-line format. Nothing dropped.
- **Stdout** (what the operator sees in `make runner`): filtered to meaningful events only, human-readable.

### Stdout filter

Always print:

- `start`
- `spawned`
- `reaped` (when count > 0; today this is already only logged when > 0 in `loop.ts`)
- `tick_error`
- `shutdown`
- `max_spawn_reached`
- `done`

Suppress:

- `tick` events where `reaped == 0 && spawned == 0` (idle ticks).

Heartbeat:

- Every 20th tick (~10 min at the 30 s default), print one line so the operator knows the runner is alive:
  ```
  [06:01:05] alive — running=1 pending=0 (logs: ./data/runner.log)
  ```

### Stdout format

Human-readable, not JSON:

```
[06:01:05] start url=http://127.0.0.1:3333/mcp poll_interval_ms=30000 max_concurrent=2
[06:01:35] spawned pid=12345
[06:11:05] alive — running=1 pending=0 (logs: ./data/runner.log)
```

The file keeps the existing JSON format so existing parsing habits (grep, jq) still work.

### Configuration

- New env var: `SAPLING_RUNNER_LOG_FILE`.
  - Default: `./data/runner.log` (resolved relative to CWD where the runner is launched, matching the existing `data/postgres` convention).
  - Set to empty string to disable file logging entirely (useful for tests / one-shot `--once` runs).
- No new `runner_config` row. File path is a local operator concern, not a fleet-wide setting.

### Implementation surface

- New file: `packages/runner/src/logger.ts`.
  - Exports `createLogger({ filePath: string | null, heartbeatEvery: number }): Logger`.
  - `Logger` is `(msg: string, ctx?: Record<string, unknown>) => void` — same shape as today, drop-in replacement.
  - Internally:
    - Opens an append stream to `filePath` if non-null. Writes `{ts, msg, ...ctx}\n` to it for every call.
    - Decides whether to also write to stdout based on `msg` and `ctx`:
      - For `tick`: skip if `reaped == 0 && spawned == 0`, except every Nth tick emit the heartbeat line.
      - For everything else: format pretty and write to stdout.
- `packages/runner/src/index.ts`:
  - Replace the inline `log()` function with `createLogger({ filePath: process.env.SAPLING_RUNNER_LOG_FILE ?? './data/runner.log', heartbeatEvery: 20 })`.
  - Empty string env var → `null`.
  - Pass the logger to `tick` via the existing `log` dep (no signature change in `loop.ts`).
- `packages/runner/test/logger.test.ts`:
  - Idle-tick suppression: stdout-writer not called for `tick` with reaped=0/spawned=0.
  - Heartbeat: 20th idle tick produces one stdout line.
  - Active tick (spawned > 0): always produces stdout line.
  - File channel: every call appends a JSON line (assert via in-memory writable, not real fs).
  - Inject the stdout writer and the file writable as deps so tests don't touch real I/O.

### SPEC.md update

Under the runner section, add one line: the runner writes a JSON event log to `./data/runner.log` (override with `SAPLING_RUNNER_LOG_FILE`, empty string to disable). No other SPEC sections affected.

## Risks / open questions

- Append-only file grows unbounded. Acceptable at current rate; document truncation in SPEC line.
- `./data/` may not exist on a fresh checkout that hasn't run `docker compose up`. Logger should `fs.mkdirSync(dirname, { recursive: true })` before opening the stream, or fall back to stdout-only with a warning. Pick: create the directory.
- Heartbeat interval is hard-coded to 20 ticks. If this turns out wrong in practice, promote to env var (`SAPLING_RUNNER_HEARTBEAT_EVERY`) — but not in this change.

## Out of scope (deferred)

- Log rotation.
- Structured log levels (info/warn/error).
- Shipping logs to the MCP server / DB.
- A status command or `/sapling:runner` skill.
