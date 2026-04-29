import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/spawn.js';

describe('spawnAgent', () => {
  it('spawns a child via bash -lc and exits 0 for `echo hi`', async () => {
    const child = spawnAgent('echo hi >/dev/null', { ...process.env });
    expect(child.pid).toBeGreaterThan(0);
    const result = await child.onExit;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it('passes the whole command as a single arg to bash (shell metacharacters work)', async () => {
    // Two semicolons would tokenize wrong if we passed args separately; bash -lc handles them.
    const child = spawnAgent('true; true; exit 7', { ...process.env });
    const result = await child.onExit;
    expect(result.code).toBe(7);
  });

  it('propagates SIGTERM to the child', async () => {
    const child = spawnAgent('sleep 30', { ...process.env });
    expect(child.pid).toBeGreaterThan(0);
    // Give bash a moment to fork the sleep child.
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGTERM');
    const result = await child.onExit;
    // bash -lc reports either signal exit or non-zero code on signal; either is acceptable.
    expect(result.code === null || result.code !== 0).toBe(true);
  });

  it('propagates env vars to the child', async () => {
    const child = spawnAgent('test "$RUNNER_TEST_VAR" = "abc123"', {
      ...process.env,
      RUNNER_TEST_VAR: 'abc123',
    });
    const result = await child.onExit;
    expect(result.code).toBe(0);
  });
});
