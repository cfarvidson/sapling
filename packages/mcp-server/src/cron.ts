import { CronExpressionParser } from 'cron-parser';

export function validateCron(expr: string): string | null {
  if (!expr || typeof expr !== 'string') return 'cron expression must be a non-empty string';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    return 'cron expression must have exactly 5-field format (m h dom mon dow)';
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (err) {
    return `invalid cron expression: ${(err as Error).message}`;
  }
}

export function validateTimezone(tz: string): string | null {
  if (!tz || typeof tz !== 'string') return 'timezone must be a non-empty string';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return null;
  } catch {
    return `invalid timezone: ${tz}`;
  }
}

export function nextCronTick(expr: string, tz: string, from: Date): Date {
  const iter = CronExpressionParser.parse(expr, { currentDate: from, tz });
  return iter.next().toDate();
}

export function nextNCronTicks(expr: string, tz: string, from: Date, n: number): Date[] {
  const iter = CronExpressionParser.parse(expr, { currentDate: from, tz });
  const out: Date[] = [];
  for (let i = 0; i < n; i++) out.push(iter.next().toDate());
  return out;
}
