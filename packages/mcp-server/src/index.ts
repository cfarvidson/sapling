import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './server.js';
import { startScheduler } from './schedules/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const pool = createPool(config.DATABASE_URL);
  log.info('running migrations');
  await runMigrations(pool);

  const { app } = createApp({ db: pool, token: config.MCP_TOKEN, log });
  const scheduler = startScheduler(pool, log, config.SCHEDULER_TICK_MS);

  const server = app.listen(config.SAPLING_PORT, () => {
    log.info({ port: config.SAPLING_PORT }, 'sapling mcp-server listening');
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await scheduler.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
