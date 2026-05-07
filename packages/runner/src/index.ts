import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import type { Writable } from 'node:stream';
import { createLogger, type Logger } from './logger.js';
import { createHttpMcpClient, type McpClient } from './mcp_client.js';
import { tick } from './loop.js';
import { spawnAgent, type SpawnedAgent } from './spawn.js';

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SAPLING_MCP_URL ?? 'http://127.0.0.1:3333/mcp';
  const token = process.env.MCP_TOKEN;

  const log = buildLogger();
  const mcp: McpClient = await createHttpMcpClient(url, token);
  const running = new Set<SpawnedAgent>();
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
    process.exit(0);
  };

  const doTick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const r = await tick({ mcp, spawn: spawnAgent, env: process.env, running, log });
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

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const cfg = await mcp.getRunnerConfig();
  log('start', { url, poll_interval_ms: cfg.poll_interval_ms, max_concurrent: cfg.max_concurrent });

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
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
