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

function isIdleTick(ctx: Record<string, unknown> | undefined): boolean {
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
          const running = Number(ctx?.running ?? 0);
          const pending = Number(ctx?.pending ?? 0);
          deps.writeStdout(`[${time}] alive — running=${running} pending=${pending}\n`);
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
