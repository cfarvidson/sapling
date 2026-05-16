import type pino from 'pino';
import type { Db } from '../db.js';
import { fireSchedule, type FireOutcome } from './fire.js';
import type { ScheduleRow } from './db.js';

export interface TickSummary {
  due: number;
  fired: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export async function tick(db: Db, log: pino.Logger): Promise<TickSummary> {
  const start = Date.now();
  const { rows } = await db.query<ScheduleRow>(
    `SELECT * FROM schedules
      WHERE enabled = TRUE AND next_run_at <= now()
      ORDER BY next_run_at ASC`,
  );
  let fired = 0;
  let skipped = 0;
  let failed = 0;
  for (const sched of rows) {
    const outcome: FireOutcome = await fireSchedule({ db, schedule: sched, log, now: new Date() });
    if (outcome.status === 'fired') fired++;
    else if (outcome.status === 'skipped_overlap') skipped++;
    else failed++;
  }
  const summary: TickSummary = {
    due: rows.length,
    fired,
    skipped,
    failed,
    durationMs: Date.now() - start,
  };
  log.info({ event: 'schedule_tick', ...summary });
  return summary;
}

export interface SchedulerHandle {
  stop: () => Promise<void>;
}

export function startScheduler(db: Db, log: pino.Logger, intervalMs: number): SchedulerHandle {
  let running = false;
  let stopping = false;

  const runOnce = async () => {
    if (running || stopping) return;
    running = true;
    try {
      await tick(db, log);
    } catch (err) {
      log.error({ event: 'schedule_tick_error', err: (err as Error).message });
    } finally {
      running = false;
    }
  };

  const timer: NodeJS.Timeout = setInterval(runOnce, intervalMs);
  void runOnce();

  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
