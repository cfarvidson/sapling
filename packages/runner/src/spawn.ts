import { spawn, spawnSync } from 'node:child_process';

export interface SpawnedAgent {
  pid: number;
  onExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export type SpawnFn = (command: string, env: NodeJS.ProcessEnv) => SpawnedAgent;

/**
 * Spawn an agent subprocess via `bash -lc <command>`. The whole `command`
 * string is passed as a single argv element to bash, so the runner does not
 * tokenize it — bash does. This keeps `agent_command` shape-compatible with
 * what users would type at a shell prompt.
 *
 * `detached: true` makes the child a process-group leader; `kill` then signals
 * the whole group (`-pid`) so descendants of the bash wrapper (the actual
 * `claude` agent that bash exec'd or forked) terminate with it instead of
 * being orphaned to launchd/init when the runner shuts down.
 *
 * `SAPLING_RUNNER=1` is injected so the spawned agent can detect it has no
 * interactive human and must use `mcp__sapling__request_human_input` instead
 * of asking plain-text questions that nothing will ever read.
 */
export const spawnAgent: SpawnFn = (command, env) => {
  const child = spawn('bash', ['-lc', command], {
    env: { ...env, SAPLING_RUNNER: '1' },
    stdio: 'inherit',
    detached: true,
  });

  const onExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const pid = child.pid;

  return {
    pid: pid ?? -1,
    onExit,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (pid === undefined) return false;
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        // ESRCH: group is already gone. Nothing left to signal.
        return false;
      }
    },
  };
};

/**
 * Construct the argv passed to `tmux` to spawn an agent as a new window.
 *
 * Exposed for unit testing — the runtime spawner below just feeds the result
 * into `spawnSync('tmux', ...)`. Keeping it pure lets us assert the argv
 * shape without needing a real tmux server during tests.
 *
 * Notes:
 * - `-d` keeps the new window in the background so the user's focus doesn't
 *   jump every time the runner spawns.
 * - `-P -F '#{window_id}\t#{pane_pid}'` prints the two stable identifiers we
 *   need: the window id (for `kill-window`) and the pane's foreground pid
 *   (for exit detection via `kill(pid, 0)`).
 * - `-e KEY=VALUE` injects env vars into the new window. tmux does NOT
 *   inherit env from the calling client by default, so this is how
 *   `SAPLING_RUNNER`, `SAPLING_TMUX_SESSION`, and the caller's env make it
 *   through.
 * - `--` separates tmux's own flags from the shell argv to execute.
 */
export function buildTmuxNewWindowArgs(opts: {
  sessionName: string;
  windowName: string;
  env: Record<string, string>;
  command: string;
}): string[] {
  const envArgs = Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return [
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{window_id}\t#{pane_pid}',
    '-t',
    opts.sessionName,
    '-n',
    opts.windowName,
    ...envArgs,
    '--',
    'bash',
    '-lc',
    opts.command,
  ];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll-based watcher that resolves when the given pid no longer exists.
 *
 * tmux-spawned children are not in our process tree, so we can't `await`
 * them like a `child_process` handle. The pane pid is reported by tmux at
 * spawn time; we then check existence with `kill(pid, 0)` every `intervalMs`
 * and resolve as soon as it's gone. Exit code and signal are unavailable
 * through this channel — `null/null` mirrors the no-info shape callers
 * already tolerate.
 */
function watchUntilExit(
  pid: number,
  intervalMs = 500,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(t);
        resolve({ code: null, signal: null });
      }
    }, intervalMs);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Build a SpawnFn that runs each agent inside its own tmux window in a
 * shared session. The caller is responsible for ensuring the session
 * already exists (the `make tui` target handles bootstrap).
 *
 * Why this exists: when the runner runs inside tmux, `stdio: 'inherit'`
 * would interleave every agent's output into the runner's window, making
 * multi-concurrency unusable. Per-window output is the fix, and it also
 * gives the TUI a `tmux switch-client` target per work item.
 *
 * Caveats:
 * - Exit code is not surfaced (see watchUntilExit). The runner only uses
 *   `onExit` to remove the child from `running`, so this is fine.
 * - `kill` calls `tmux kill-window`. The `signal` argument is ignored —
 *   tmux always sends SIGHUP — which matches the runner's existing
 *   "best-effort SIGTERM, SIGKILL on shutdown deadline" intent closely
 *   enough for shutdown.
 */
export function makeTmuxSpawner(sessionName: string): SpawnFn {
  let seq = 0;
  return (command, env) => {
    seq += 1;
    const windowName = `spawn-${seq}`;
    const fullEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) fullEnv[k] = String(v);
    }
    fullEnv.SAPLING_RUNNER = '1';
    fullEnv.SAPLING_TMUX_SESSION = sessionName;

    const args = buildTmuxNewWindowArgs({ sessionName, windowName, env: fullEnv, command });
    const result = spawnSync('tmux', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      throw new Error(`tmux new-window failed (exit ${result.status}): ${stderr}`);
    }
    const stdout = (result.stdout ?? '').trim();
    const [windowId, panePidStr] = stdout.split('\t');
    const panePid = Number(panePidStr);
    if (!windowId || !Number.isFinite(panePid) || panePid <= 0) {
      throw new Error(`tmux new-window returned unparseable output: ${JSON.stringify(stdout)}`);
    }

    const onExit = watchUntilExit(panePid);

    return {
      pid: panePid,
      onExit,
      kill: () => {
        const k = spawnSync('tmux', ['kill-window', '-t', windowId], { encoding: 'utf8' });
        return k.status === 0;
      },
    };
  };
}
