import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'sapling' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
