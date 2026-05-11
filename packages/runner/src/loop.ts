import type { McpClient } from './mcp_client.js';
import { nagAwaitingInput } from './notifier.js';
import type { SpawnedAgent, SpawnFn } from './spawn.js';

export interface TickDeps {
  mcp: McpClient;
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  running: Set<SpawnedAgent>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** When provided, the notifier runs each tick and persists per-id last-notified times here. */
  notifierState?: Map<number, Date>;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TickResult {
  reaped: number;
  spawned: number;
  pending: number;
  running: number;
  awaiting_input: number;
  nagged: number;
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { mcp, spawn, env, running, log, notifierState, fetchImpl } = deps;

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

  let awaiting = 0;
  let nagged = 0;
  if (notifierState) {
    const items = await mcp.listAwaitingInput();
    const r = await nagAwaitingInput({
      items,
      ntfyUrl: cfg.ntfy_url,
      nagAgeMs: cfg.awaiting_input_nag_age_ms,
      nagRepeatMs: cfg.awaiting_input_nag_repeat_ms,
      lastNotified: notifierState,
      fetchImpl,
      log,
    });
    awaiting = r.count;
    nagged = r.nagged;
    if (awaiting > 0) {
      log?.('awaiting_input', { count: awaiting, oldest_age_ms: r.oldestAgeMs, nagged });
    }
  }

  return {
    reaped: reaped.length,
    spawned: toSpawn,
    pending: pending.length,
    running: running.size,
    awaiting_input: awaiting,
    nagged,
  };
}
