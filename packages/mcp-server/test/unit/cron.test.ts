import { describe, expect, it } from 'vitest';
import { nextCronTick, validateCron, validateTimezone } from '../../src/cron.js';

describe('cron helpers', () => {
  it('nextCronTick returns the next minute boundary for "* * * * *"', () => {
    const from = new Date('2026-05-11T12:00:00Z');
    const next = nextCronTick('* * * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-05-11T12:01:00.000Z');
  });

  it('nextCronTick honours the timezone (9am Stockholm = 08:00 UTC in winter)', () => {
    const from = new Date('2026-01-15T06:30:00Z');
    const next = nextCronTick('0 9 * * *', 'Europe/Stockholm', from);
    expect(next.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('validateCron returns null for valid 5-field expressions', () => {
    expect(validateCron('0 * * * *')).toBeNull();
    expect(validateCron('*/15 9-17 * * 1-5')).toBeNull();
  });

  it('validateCron returns an error string for invalid expressions', () => {
    expect(validateCron('not-cron')).toMatch(/cron/i);
    expect(validateCron('')).toMatch(/cron/i);
  });

  it('validateCron rejects 6-field (seconds) cron', () => {
    expect(validateCron('0 0 * * * *')).toMatch(/5-field|invalid/i);
  });

  it('validateTimezone accepts IANA zones and rejects others', () => {
    expect(validateTimezone('UTC')).toBeNull();
    expect(validateTimezone('Europe/Stockholm')).toBeNull();
    expect(validateTimezone('Mars/Olympus')).toMatch(/timezone|invalid/i);
    expect(validateTimezone('')).toMatch(/timezone|invalid/i);
  });
});
