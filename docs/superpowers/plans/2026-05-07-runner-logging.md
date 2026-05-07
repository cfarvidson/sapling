# Runner logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quiet `make runner` stdout to meaningful events only, while persisting the full JSON event stream to `./data/runner.log`.

**Architecture:** Extract logger into `packages/runner/src/logger.ts`. The logger writes every event as a JSON line to a file stream (default `./data/runner.log`), and conditionally writes a pretty-formatted line to stdout: always for meaningful events, never for idle ticks (`reaped == 0 && spawned == 0`), and once every 20th tick as a heartbeat. `index.ts` constructs the logger from env vars at startup and passes it to `tick` via the existing `log` dependency — no signature changes downstream.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22, vitest, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-07-runner-logging-design.md`

---

## File Structure

- **Create** `packages/runner/src/logger.ts` — logger factory with stdout filtering, file appending, and heartbeat counting. Pure module; no top-level side effects.
- **Create** `packages/runner/test/logger.test.ts` — unit tests for filter, heartbeat, file output, and disable-via-empty-string.
- **Modify** `packages/runner/src/index.ts` — replace inline `log()` function with `createLogger()` constructed from env vars; remove the `log` helper.
- **Modify** `SPEC.md` — one-line note in §11 (Autonomous mode) about `runner.log`; add `SAPLING_RUNNER_LOG_FILE` to §13 Configuration surface; add the env var to the §11 Environment table.

No plugin version bump (no `packages/claude-plugin/` changes).

---

### Task 1: Logger module + tests

**Files:**
- Create: `packages/runner/src/logger.ts`
- Create: `packages/runner/test/logger.test.ts`

This task does TDD: tests first, then implementation. The logger is the only new piece of logic, so all behavior gets tested here. We inject the stdout writer and the file writable so tests stay in-memory — no real fs / stdout side effects.

- [ ] **Step 1: Write the failing tests**

Create `packages/runner/test/logger.test.ts` with this exact content:

```typescript
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, type LoggerDeps } from '../src/logger.js';

interface Captured {
  stdout: string[];
  file: string[];
}

function makeDeps(overrides: Partial<LoggerDeps> = {}): { deps: LoggerDeps; cap: Captured } {
  const cap: Captured = { stdout: [], file: [] };
  const fileStream = new Writable({
    write(chunk, _enc, cb) {
      cap.file.push(String(chunk));
      cb();
    },
  });
  const deps: LoggerDeps = {
    fileStream,
    writeStdout: (s) => {
      cap.stdout.push(s);
    },
    heartbeatEvery: 20,
    now: () => new Date('2026-05-07T06:00:00.000Z'),
    ...overrides,
  };
  return { deps, cap };
}

describe('createLogger', () => {
  it('writes every event to the file as a JSON line', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('start', { url: 'http://x' });
    log('spawned', { pid: 42 });
    expect(cap.file).toHaveLength(2);
    expect(JSON.parse(cap.file[0])).toEqual({
      ts: '2026-05-07T06:00:00.000Z',
      msg: 'start',
      url: 'http://x',
    });
    expect(JSON.parse(cap.file[1])).toEqual({
      ts: '2026-05-07T06:00:00.000Z',
      msg: 'spawned',
      pid: 42,
    });
  });

  it('suppresses idle tick events from stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(0);
    expect(cap.file).toHaveLength(1); // file still gets it
  });

  it('writes active tick events to stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 1, pending: 4, running: 2 });
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]).toContain('tick');
    expect(cap.stdout[0]).toContain('spawned=1');
  });

  it('emits a heartbeat on the Nth idle tick', () => {
    const { deps, cap } = makeDeps({ heartbeatEvery: 3 });
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(0);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]).toContain('alive');
    expect(cap.stdout[0]).toContain('running=1');
    expect(cap.stdout[0]).toContain('pending=0');
  });

  it('resets the heartbeat counter when an active tick is logged', () => {
    const { deps, cap } = makeDeps({ heartbeatEvery: 3 });
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 1
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 2
    log('tick', { reaped: 0, spawned: 1, pending: 0, running: 2 }); // active — resets
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 1 again
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 2
    // The active tick produced one stdout line; no heartbeat yet.
    expect(cap.stdout).toHaveLength(1);
  });

  it('always writes non-tick events to stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('start', { url: 'http://x', poll_interval_ms: 30000, max_concurrent: 2 });
    log('spawned', { pid: 42 });
    log('reaped', { ids: [7] });
    log('tick_error', { err: 'boom' });
    log('shutdown', { sig: 'SIGTERM', running: 0 });
    expect(cap.stdout).toHaveLength(5);
    expect(cap.stdout[0]).toContain('start');
    expect(cap.stdout[3]).toContain('tick_error');
  });

  it('formats stdout as [HH:MM:SS] msg key=value pairs', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('spawned', { pid: 42 });
    expect(cap.stdout[0]).toMatch(/^\[06:00:00\] spawned pid=42\n?$/);
  });

  it('omits file writes when fileStream is null', () => {
    const { deps, cap } = makeDeps({ fileStream: null });
    const log = createLogger(deps);
    log('start', { url: 'http://x' });
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.file).toHaveLength(0);
    // stdout still works
    expect(cap.stdout).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter sapling-runner test logger`
Expected: FAIL with `Cannot find module '../src/logger.js'` (or equivalent — the module does not exist yet).

- [ ] **Step 3: Implement the logger module**

Create `packages/runner/src/logger.ts` with this exact content:

```typescript
import type { Writable } from 'node:stream';

export type Logger = (msg: string, ctx?: Record<string, unknown>) => void;

export interface LoggerDeps {
  /** Append-only stream for the JSON event log, or null to disable file logging. */
  fileStream: Writable | null;
  /** Called for every line that should appear on stdout. Tests inject a capture; production passes a stdout writer. */
  writeStdout: (line: string) => void;
  /** Emit a heartbeat line every Nth consecutive idle tick. */
  heartbeatEvery: number;
  /** Override for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

interface TickCtx {
  reaped: number;
  spawned: number;
  pending: number;
  running: number;
}

function isIdleTick(ctx: Record<string, unknown> | undefined): ctx is unknown as TickCtx {
  return (
    !!ctx &&
    typeof ctx.reaped === 'number' &&
    typeof ctx.spawned === 'number' &&
    ctx.reaped === 0 &&
    ctx.spawned === 0
  );
}

function formatTime(d: Date): string {
  return d.toISOString().slice(11, 19); // HH:MM:SS from ISO
}

function formatPretty(time: string, msg: string, ctx?: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) return `[${time}] ${msg}\n`;
  const pairs = Object.entries(ctx)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `[${time}] ${msg} ${pairs}\n`;
}

export function createLogger(deps: LoggerDeps): Logger {
  const now = deps.now ?? ((): Date => new Date());
  let idleStreak = 0;

  return (msg, ctx) => {
    const d = now();
    const ts = d.toISOString();
    const time = formatTime(d);

    // File: every event, JSON line.
    if (deps.fileStream) {
      const entry = JSON.stringify({ ts, msg, ...(ctx ?? {}) }) + '\n';
      deps.fileStream.write(entry);
    }

    // Stdout: filter ticks, pretty-format everything else.
    if (msg === 'tick') {
      if (isIdleTick(ctx)) {
        idleStreak += 1;
        if (idleStreak >= deps.heartbeatEvery) {
          const tickCtx = ctx as unknown as TickCtx;
          deps.writeStdout(
            `[${time}] alive — running=${tickCtx.running} pending=${tickCtx.pending}\n`,
          );
          idleStreak = 0;
        }
        return;
      }
      // Active tick — reset the streak and print.
      idleStreak = 0;
      deps.writeStdout(formatPretty(time, 'tick', ctx));
      return;
    }

    // Non-tick events always go to stdout.
    deps.writeStdout(formatPretty(time, msg, ctx));
  };
}
```

Note on the `isIdleTick` cast: the `is unknown as TickCtx` narrowing form is non-standard. Replace it in the actual file with a plain boolean predicate, then cast at the call site:

```typescript
function isIdleTick(ctx: Record<string, unknown> | undefined): boolean {
  return (
    !!ctx &&
    typeof ctx.reaped === 'number' &&
    typeof ctx.spawned === 'number' &&
    ctx.reaped === 0 &&
    ctx.spawned === 0
  );
}
```

And in the heartbeat branch, read `ctx.running` / `ctx.pending` as `number`:

```typescript
const running = Number(ctx?.running ?? 0);
const pending = Number(ctx?.pending ?? 0);
deps.writeStdout(`[${time}] alive — running=${running} pending=${pending}\n`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter sapling-runner test logger`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter sapling-runner typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Format and lint**

Run: `npx prettier --write packages/runner/src/logger.ts packages/runner/test/logger.test.ts`
Run: `pnpm -w lint --fix` if a workspace lint script exists; otherwise skip.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/logger.ts packages/runner/test/logger.test.ts
git commit -m "feat(runner): logger module with file output and stdout filtering"
```

---

### Task 2: Wire the logger into the runner

**Files:**
- Modify: `packages/runner/src/index.ts`

The inline `log()` helper at `packages/runner/src/index.ts:28-31` is replaced by `createLogger()`. The logger is constructed at startup using `SAPLING_RUNNER_LOG_FILE` (default `./data/runner.log`, empty string disables file logging). The directory is created on demand so a fresh checkout that hasn't run `docker compose up` still works.

- [ ] **Step 1: Replace the imports and log helper in `index.ts`**

Replace lines 1-4 of `packages/runner/src/index.ts`:

```typescript
import process from 'node:process';
import { createHttpMcpClient, type McpClient } from './mcp_client.js';
import { tick } from './loop.js';
import { spawnAgent, type SpawnedAgent } from './spawn.js';
```

with:

```typescript
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import type { Writable } from 'node:stream';
import { createLogger, type Logger } from './logger.js';
import { createHttpMcpClient, type McpClient } from './mcp_client.js';
import { tick } from './loop.js';
import { spawnAgent, type SpawnedAgent } from './spawn.js';
```

- [ ] **Step 2: Remove the inline `log()` function**

Delete lines 28-31 of the original file (the `function log(msg, ctx?)` helper).

- [ ] **Step 3: Add a logger factory helper above `main()`**

Insert this function in `index.ts`, just above `async function main()`:

```typescript
const HEARTBEAT_EVERY = 20;
const DEFAULT_LOG_FILE = './data/runner.log';

function openLogFile(envVar: string | undefined): Writable | null {
  // Empty string explicitly disables file logging.
  if (envVar === '') return null;
  const path = resolve(envVar ?? DEFAULT_LOG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}

function buildLogger(): Logger {
  const fileStream = openLogFile(process.env.SAPLING_RUNNER_LOG_FILE);
  return createLogger({
    fileStream,
    writeStdout: (s) => process.stdout.write(s),
    heartbeatEvery: HEARTBEAT_EVERY,
  });
}
```

- [ ] **Step 4: Use the logger in `main()`**

At the top of `main()`, after `parseArgs`, replace the current loose `log(...)` calls with calls into a constructed logger. Replace the start of `main()`:

```typescript
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SAPLING_MCP_URL ?? 'http://127.0.0.1:3333/mcp';
  const token = process.env.MCP_TOKEN;

  const mcp: McpClient = await createHttpMcpClient(url, token);
```

with:

```typescript
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SAPLING_MCP_URL ?? 'http://127.0.0.1:3333/mcp';
  const token = process.env.MCP_TOKEN;

  const log = buildLogger();
  const mcp: McpClient = await createHttpMcpClient(url, token);
```

The existing `log(...)` calls at the original lines 55, 70, 73, 77, 85, 98 already match the `Logger` signature (`(msg, ctx?) => void`), so no further call-site edits are needed. The `tick` call at line 69 already passes `log` as the dep — that keeps working unchanged.

- [ ] **Step 5: Confirm the file compiles and existing tests still pass**

Run: `pnpm --filter sapling-runner typecheck`
Expected: no output, exit 0.

Run: `pnpm --filter sapling-runner test`
Expected: PASS — all logger tests + all existing loop/spawn tests.

- [ ] **Step 6: Format**

Run: `npx prettier --write packages/runner/src/index.ts`

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/index.ts
git commit -m "feat(runner): use file+stdout logger in main"
```

---

### Task 3: Update SPEC.md

**Files:**
- Modify: `SPEC.md`

Sapling project rule (`CLAUDE.md`): SPEC.md must be updated in the same PR as runtime topology / runner config / configuration surface changes. This change adds a new env var and a new on-disk artifact.

- [ ] **Step 1: Add the `SAPLING_RUNNER_LOG_FILE` row to §11 Environment table**

Find the `### Environment` table inside §11 (around line 565). Add a row:

```markdown
| `SAPLING_RUNNER_LOG_FILE` | `./data/runner.log`         | JSON event log path. Empty string disables file logging. |
```

- [ ] **Step 2: Add a stdout-vs-file note inside §11**

Below the `### Environment` table, add a short subsection:

```markdown
### Logging

The runner writes every event as a JSON line to the file at `SAPLING_RUNNER_LOG_FILE` (default `./data/runner.log`; empty string disables). The parent directory is created on demand. Stdout is filtered for human reading: `start`, `spawned`, `reaped`, `tick_error`, `shutdown`, `max_spawn_reached`, and `done` always print; idle ticks (`reaped == 0 && spawned == 0`) are suppressed; an `alive — running=N pending=N` heartbeat prints every 20th idle tick.
```

- [ ] **Step 3: Add `SAPLING_RUNNER_LOG_FILE` to §13 Configuration surface table**

In §13's table (around line 617), add a row near the existing `SAPLING_MCP_URL` row:

```markdown
| `SAPLING_RUNNER_LOG_FILE` | runner env | `./data/runner.log` | JSON event log path. Empty string disables file logging. |
```

- [ ] **Step 4: Format the doc**

Run: `npx prettier --write SPEC.md`

- [ ] **Step 5: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): document runner log file and stdout filter"
```

---

### Task 4: Smoke test against a live runner

**Files:** none modified.

Goal: confirm the change works end-to-end before declaring done. Type-checks and unit tests do not exercise the actual `./data/runner.log` write or the `make runner` console output.

- [ ] **Step 1: Bring the stack up**

Run: `make up` (or skip if already running).
Run: `docker compose ps` — confirm `mcp-server` and `postgres` are healthy.

- [ ] **Step 2: Truncate any prior log so the smoke output is clean**

Run: `: > ./data/runner.log` (creates an empty file; ignore "no such file" if absent).

- [ ] **Step 3: Run `make runner` for ~2 minutes with no pending work**

Run: `make runner` in one terminal.
Expected stdout (within ~5 s):
```
[HH:MM:SS] start url=http://127.0.0.1:3333/mcp poll_interval_ms=30000 max_concurrent=2
```
Expected: NO further lines for the next ~2 minutes (idle ticks are suppressed; heartbeat only fires at tick 20 ≈ 10 min).
`Ctrl-C` → expect `[HH:MM:SS] shutdown sig=SIGINT running=0` then exit.

- [ ] **Step 4: Verify the file received the full event stream**

Run: `wc -l ./data/runner.log` — expect ≥ 5 lines (start + several ticks + shutdown).
Run: `jq -r '.msg' ./data/runner.log | sort | uniq -c` — expect at least `start`, `tick`, `shutdown`.
Run: `jq 'select(.msg=="tick") | {reaped, spawned}' ./data/runner.log | head` — confirm idle ticks are present in the file even though they were absent on stdout.

- [ ] **Step 5: Verify the heartbeat path with a shortened test**

Temporarily set `HEARTBEAT_EVERY = 3` in `packages/runner/src/index.ts`, run `make runner`, wait ~90 s, expect one `[HH:MM:SS] alive — running=0 pending=0` line on stdout. Revert the constant.

(Keep this step manual — no automated test for the env-driven heartbeat in this scope.)

- [ ] **Step 6: Verify the disable path**

Run: `SAPLING_RUNNER_LOG_FILE='' make runner` for ~5 s, `Ctrl-C`.
Expected: no new writes to `./data/runner.log` (compare `stat -f %m ./data/runner.log` before/after, or check `wc -l`).

- [ ] **Step 7: Run the full test suite once more before pushing**

Run: `make test`
Expected: all tests pass.

- [ ] **Step 8: No commit needed for smoke test (no file changes).**

If anything was modified during smoke testing (e.g., the `HEARTBEAT_EVERY` revert), confirm `git status` is clean before pushing.

---

## Self-review

**Spec coverage:**
- Two channels (file + stdout) — Task 1 (logger), Task 2 (wiring). ✓
- Stdout filter rules (idle suppression, heartbeat every 20, always-show events) — Task 1 tests + impl. ✓
- Stdout pretty format `[HH:MM:SS] msg k=v` — Task 1 test "formats stdout". ✓
- File JSON-line format — Task 1 test "writes every event to the file". ✓
- `SAPLING_RUNNER_LOG_FILE` env var, default `./data/runner.log`, empty string disables — Task 2 (`openLogFile`) + Task 1 test "omits file writes when fileStream is null". ✓
- `mkdirSync(..., { recursive: true })` for missing `./data/` — Task 2 (`openLogFile`). ✓
- No `runner_config` row, no plugin version bump — explicitly out of scope; not in any task. ✓
- SPEC.md updates — Task 3. ✓
- No log rotation, no `make runner-logs`, no status command — explicitly out of scope. ✓

**Type consistency:** `Logger` type defined in Task 1 is imported and used in Task 2. `LoggerDeps` only used by tests + `createLogger`. Heartbeat constant `HEARTBEAT_EVERY` is module-local in Task 2 and not exported.

**Placeholder scan:** No "TBD"/"TODO" in plan. All code blocks contain real code. The `is unknown as TickCtx` quirk in Step 3 is called out and replaced with a plain boolean predicate.
