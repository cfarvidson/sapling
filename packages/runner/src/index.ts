import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import type { Writable } from 'node:stream';
import { createLogger, type Logger } from './logger.js';
import { createHttpMcpClient, type McpClient } from 'sapling-mcp-client';
import { tick } from './loop.js';
import { makeTmuxSpawner, spawnAgent, type SpawnFn, type SpawnedAgent } from './spawn.js';
import { detectForeignWindows, listSessionWindowNames } from './tmux_safety.js';

interface CliArgs {
  once: boolean;
  maxSpawn: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  let once = false;
  let maxSpawn: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') {
      once = true;
    } else if (argv[i] === '--max-spawn') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--max-spawn requires a positive integer');
      maxSpawn = v;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  return { once, maxSpawn };
}

const SHUTDOWN_GRACE_MS = 30_000;

async function waitForChildren(running: Set<SpawnedAgent>, deadline: number): Promise<void> {
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Consecutive idle ticks before emitting an "alive" heartbeat to stdout.
const HEARTBEAT_EVERY = 20;
const DEFAULT_LOG_FILE = './data/runner.log';

/**
 * Opens the runner's JSON event log for appending. Creates the parent directory if needed.
 * Returns null when `envVar` is the empty string (file logging explicitly disabled).
 */
function createLogFile(envVar: string | undefined): Writable | null {
  if (envVar === '') return null;
  const path = resolve(envVar ?? DEFAULT_LOG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}

function buildLogger(): { log: Logger; close: () => Promise<void> } {
  const fileStream = createLogFile(process.env.SAPLING_RUNNER_LOG_FILE);
  const log = createLogger({
    fileStream,
    writeStdout: (s) => process.stdout.write(s),
    heartbeatEvery: HEARTBEAT_EVERY,
  });
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!fileStream) return resolve();
      fileStream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  return { log, close };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SAPLING_MCP_URL ?? 'http://127.0.0.1:3333/mcp';
  const token = process.env.MCP_TOKEN;

  const { log, close: closeLog } = buildLogger();
  const mcp: McpClient = await createHttpMcpClient(url, token);
  const running = new Set<SpawnedAgent>();
  const notifierState = new Map<number, Date>();
  let totalSpawned = 0;
  let stopping = false;
  let interval: NodeJS.Timeout | null = null;

  const shutdown = async (sig: string): Promise<void> => {
    if (stopping && interval === null) return;
    stopping = true;
    log('shutdown', { sig, running: running.size });
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    await waitForChildren(running, Date.now() + SHUTDOWN_GRACE_MS);
    for (const child of running) child.kill('SIGKILL');
    await mcp.close();
    await closeLog();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const cfg = await mcp.getRunnerConfig();

  // Pick the spawner once at startup. tmux mode requires both the config
  // toggle and an actual tmux client env (`$TMUX`). When the toggle is on but
  // the env is missing, we fall back to the bash spawner with a log so the
  // operator notices.
  const inTmux = Boolean(process.env.TMUX);
  const useTmux = cfg.use_tmux && inTmux;
  const spawnFn: SpawnFn = useTmux ? makeTmuxSpawner(cfg.tmux_session_name) : spawnAgent;
  if (cfg.use_tmux && !inTmux) {
    log('tmux_disabled_no_env', { reason: 'cfg.use_tmux=true but $TMUX is unset' });
  }

  // Multi-runner safety: when the configured tmux session already has
  // `work-<n>` windows we did not spawn, warn that another runner (or an
  // orphan from a crashed run) is likely active. We do not abort — the cost
  // of a stuck runner that refuses to start is higher than the cost of
  // trampling. The operator decides whether to kill the orphans or use a
  // different session name.
  if (useTmux) {
    const existing = listSessionWindowNames(cfg.tmux_session_name);
    const foreign = detectForeignWindows(existing, []);
    if (foreign.length > 0) {
      log('foreign_windows_detected', {
        session: cfg.tmux_session_name,
        count: foreign.length,
        names: foreign,
      });
    }
  }

  const doTick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const r = await tick({
        mcp,
        spawn: spawnFn,
        env: process.env,
        running,
        log,
        notifierState,
      });
      log('tick', { ...r });
      totalSpawned += r.spawned;
      if (args.maxSpawn !== null && totalSpawned >= args.maxSpawn) {
        log('max_spawn_reached', { totalSpawned, maxSpawn: args.maxSpawn });
        void shutdown('max-spawn');
      }
    } catch (err) {
      log('tick_error', { err: String(err) });
    }
  };

  log('start', {
    url,
    poll_interval_ms: cfg.poll_interval_ms,
    max_concurrent: cfg.max_concurrent,
    tmux: useTmux ? cfg.tmux_session_name : false,
  });

  await doTick();

  if (!args.once && !stopping) {
    interval = setInterval(() => {
      void doTick();
    }, cfg.poll_interval_ms);
  }

  if (args.once) {
    await waitForChildren(running, Date.now() + SHUTDOWN_GRACE_MS);
    await mcp.close();
    log('done', { totalSpawned });
    await closeLog();
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
