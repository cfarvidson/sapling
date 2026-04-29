import { readFile, unlink } from 'node:fs/promises';
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

  it('SIGKILL reaches grandchildren of the bash wrapper via process group', async () => {
    // bash forks `sleep 30` as a background grandchild and then waits. When the
    // runner sends SIGKILL, both bash and the backgrounded sleep must die — the
    // whole process group, not just the bash leader. The grandchild PID is
    // written to a tempfile so we can verify it was reaped after `kill`.
    const tmp = `/tmp/sapling-runner-spawn-test-${process.pid}-${Date.now()}.pid`;
    const child = spawnAgent(`sleep 30 & echo $! > ${tmp}; wait $!`, { ...process.env });
    // Give bash a moment to fork sleep and write the pid file.
    await new Promise((r) => setTimeout(r, 300));
    const grandchildPid = Number((await readFile(tmp, 'utf8')).trim());
    expect(grandchildPid).toBeGreaterThan(0);
    child.kill('SIGKILL');
    await child.onExit;
    // After the runner's group-kill, the grandchild should be gone too.
    // `process.kill(pid, 0)` throws ESRCH if the process no longer exists.
    // Allow a brief wait for the kernel to reap.
    await new Promise((r) => setTimeout(r, 200));
    let stillAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
    await unlink(tmp).catch(() => undefined);
  });
});
