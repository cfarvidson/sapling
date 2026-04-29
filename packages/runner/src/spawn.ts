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
 */
export const spawnAgent: SpawnFn = (command, env) => {
  const child = spawn('bash', ['-lc', command], {
    env,
    stdio: 'inherit',
  });

  const onExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    pid: child.pid ?? -1,
    onExit,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal),
  };
};
