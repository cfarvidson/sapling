import type { McpClient } from './mcp_client.js';
import type { SpawnedAgent, SpawnFn } from './spawn.js';

export interface TickDeps {
  mcp: McpClient;
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  running: Set<SpawnedAgent>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TickResult {
  reaped: number;
  spawned: number;
  pending: number;
  running: number;
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { mcp, spawn, env, running, log } = deps;

  const reaped = await mcp.reapStuckClaims();
  if (reaped.length > 0) log?.('reaped', { ids: reaped.map((r) => r.id) });

  const cfg = await mcp.getRunnerConfig();
  const pending = await mcp.listPendingWork();

  const available = Math.max(0, cfg.max_concurrent - running.size);
  const toSpawn = Math.min(available, pending.length);

  for (let i = 0; i < toSpawn; i++) {
    const child = spawn(cfg.agent_command, env);
    running.add(child);
    void child.onExit.then(() => {
      running.delete(child);
    });
    log?.('spawned', { pid: child.pid });
  }

  return {
    reaped: reaped.length,
    spawned: toSpawn,
    pending: pending.length,
    running: running.size,
  };
}
