import { spawn } from 'node:child_process';

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
 */
export const spawnAgent: SpawnFn = (command, env) => {
  const child = spawn('bash', ['-lc', command], {
    env,
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
