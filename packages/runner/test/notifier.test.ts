import { describe, expect, it, vi } from 'vitest';
import { nagAwaitingInput, type NagDeps } from '../src/notifier.js';

function fixedNow(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

function buildDeps(overrides: Partial<NagDeps> = {}): NagDeps {
  return {
    items: [],
    ntfyUrl: 'http://localhost:8080/sapling',
    nagAgeMs: 60_000,
    nagRepeatMs: 300_000,
    lastNotified: new Map(),
    fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
    log: vi.fn(),
    now: fixedNow('2026-05-10T12:00:00.000Z'),
    ...overrides,
  };
}

describe('nagAwaitingInput', () => {
  it('returns count=0 and oldestAgeMs=0 when there are no items', async () => {
    const r = await nagAwaitingInput(buildDeps());
    expect(r).toEqual({ count: 0, oldestAgeMs: 0, nagged: 0 });
  });

  it('does not POST when ntfyUrl is null', async () => {
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        ntfyUrl: null,
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T11:00:00.000Z' }],
        fetchImpl,
      }),
    );
    expect(r.count).toBe(1);
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips items younger than nagAgeMs', async () => {
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T11:59:30.000Z' }], // 30s old
        nagAgeMs: 60_000,
        fetchImpl,
      }),
    );
    expect(r.count).toBe(1);
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs to ntfy for items older than nagAgeMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 7, title: 'plan a thing', updated_at: '2026-05-10T11:00:00.000Z' }], // 1h old
        fetchImpl,
      }),
    );
    expect(r.nagged).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8080/sapling');
    expect((init as RequestInit).method).toBe('POST');
    expect(String((init as RequestInit).body)).toContain('plan a thing');
    expect(String((init as RequestInit).body)).toContain('#7');
  });

  it('does not double-nag inside nagRepeatMs', async () => {
    const lastNotified = new Map<number, Date>([
      [1, new Date('2026-05-10T11:58:00.000Z')], // 2 min ago < 5 min repeat window
    ]);
    const fetchImpl = vi.fn();
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 1, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
        fetchImpl,
      }),
    );
    expect(r.nagged).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records last-notified time after a successful POST', async () => {
    const lastNotified = new Map<number, Date>();
    await nagAwaitingInput(
      buildDeps({
        items: [{ id: 9, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
      }),
    );
    expect(lastNotified.get(9)?.toISOString()).toBe('2026-05-10T12:00:00.000Z');
  });

  it('does not record last-notified time on HTTP failure and logs the error', async () => {
    const lastNotified = new Map<number, Date>();
    const log = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await nagAwaitingInput(
      buildDeps({
        items: [{ id: 9, title: 't', updated_at: '2026-05-10T10:00:00.000Z' }],
        lastNotified,
        fetchImpl,
        log,
      }),
    );
    expect(r.nagged).toBe(0);
    expect(lastNotified.has(9)).toBe(false);
    expect(log).toHaveBeenCalledWith('notify_error', expect.any(Object));
  });

  it('reports oldestAgeMs across all items even when none are nagged', async () => {
    const r = await nagAwaitingInput(
      buildDeps({
        items: [
          { id: 1, title: 't', updated_at: '2026-05-10T11:59:30.000Z' }, // 30s
          { id: 2, title: 'u', updated_at: '2026-05-10T11:50:00.000Z' }, // 10m
        ],
        nagAgeMs: 24 * 60 * 60 * 1000, // disable nagging
      }),
    );
    expect(r.count).toBe(2);
    expect(r.oldestAgeMs).toBe(10 * 60 * 1000);
    expect(r.nagged).toBe(0);
  });
});
