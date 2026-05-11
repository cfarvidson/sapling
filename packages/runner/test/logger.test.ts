import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, type LoggerDeps } from '../src/logger.js';

interface Captured {
  stdout: string[];
  file: string[];
}

function makeDeps(overrides: Partial<LoggerDeps> = {}): { deps: LoggerDeps; cap: Captured } {
  const cap: Captured = { stdout: [], file: [] };
  const fileStream = new Writable({
    write(chunk, _enc, cb) {
      cap.file.push(String(chunk));
      cb();
    },
  });
  const deps: LoggerDeps = {
    fileStream,
    writeStdout: (s) => {
      cap.stdout.push(s);
    },
    heartbeatEvery: 20,
    now: () => new Date('2026-05-07T06:00:00.000Z'),
    ...overrides,
  };
  return { deps, cap };
}

describe('createLogger', () => {
  it('writes every event to the file as a JSON line', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('start', { url: 'http://x' });
    log('spawned', { pid: 42 });
    expect(cap.file).toHaveLength(2);
    expect(JSON.parse(cap.file[0])).toEqual({
      ts: '2026-05-07T06:00:00.000Z',
      msg: 'start',
      url: 'http://x',
    });
    expect(JSON.parse(cap.file[1])).toEqual({
      ts: '2026-05-07T06:00:00.000Z',
      msg: 'spawned',
      pid: 42,
    });
  });

  it('suppresses idle tick events from stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(0);
    expect(cap.file).toHaveLength(1); // file still gets it
  });

  it('writes active tick events to stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 1, pending: 4, running: 2 });
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]).toContain('tick');
    expect(cap.stdout[0]).toContain('spawned=1');
  });

  it('emits a heartbeat on the Nth idle tick', () => {
    const { deps, cap } = makeDeps({ heartbeatEvery: 3 });
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(0);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]).toContain('alive');
    expect(cap.stdout[0]).toContain('running=1');
    expect(cap.stdout[0]).toContain('pending=0');
  });

  it('resets the heartbeat counter when an active tick is logged', () => {
    const { deps, cap } = makeDeps({ heartbeatEvery: 3 });
    const log = createLogger(deps);
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 1
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 2
    log('tick', { reaped: 0, spawned: 1, pending: 0, running: 2 }); // active — resets
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 1 again
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 }); // idle 2
    // The active tick produced one stdout line; no heartbeat yet.
    expect(cap.stdout).toHaveLength(1);
  });

  it('always writes non-tick events to stdout', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('start', { url: 'http://x', poll_interval_ms: 30000, max_concurrent: 2 });
    log('spawned', { pid: 42 });
    log('reaped', { ids: [7] });
    log('tick_error', { err: 'boom' });
    log('shutdown', { sig: 'SIGTERM', running: 0 });
    expect(cap.stdout).toHaveLength(5);
    expect(cap.stdout[0]).toContain('start');
    expect(cap.stdout[3]).toContain('tick_error');
  });

  it('formats stdout as [HH:MM:SS] msg key=value pairs', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('spawned', { pid: 42 });
    expect(cap.stdout[0]).toMatch(/^\[06:00:00\] spawned pid=42\n?$/);
  });

  it('surfaces awaiting_input events to stdout when count > 0', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('awaiting_input', { count: 3, oldest_age_ms: 4 * 60 * 60 * 1000, nagged: 1 });
    expect(cap.stdout).toHaveLength(1);
    expect(cap.stdout[0]).toContain('awaiting_input');
    expect(cap.stdout[0]).toContain('count=3');
    expect(cap.stdout[0]).toContain('oldest=4h');
  });

  it('skips awaiting_input on stdout when count is 0', () => {
    const { deps, cap } = makeDeps();
    const log = createLogger(deps);
    log('awaiting_input', { count: 0, oldest_age_ms: 0, nagged: 0 });
    expect(cap.stdout).toHaveLength(0);
    // file still gets it for completeness.
    expect(cap.file).toHaveLength(1);
  });

  it('omits file writes when fileStream is null', () => {
    const { deps, cap } = makeDeps({ fileStream: null });
    const log = createLogger(deps);
    log('start', { url: 'http://x' });
    log('tick', { reaped: 0, spawned: 0, pending: 0, running: 1 });
    expect(cap.file).toHaveLength(0);
    // stdout still works
    expect(cap.stdout).toHaveLength(1);
  });
});
