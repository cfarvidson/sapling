import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildTmuxNewWindowArgs, makeTmuxSpawner, spawnAgent } from '../src/spawn.js';

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

  it('injects SAPLING_RUNNER=1 so the spawned agent knows it is non-interactive', async () => {
    const child = spawnAgent('test "$SAPLING_RUNNER" = "1"', { ...process.env });
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

describe('buildTmuxNewWindowArgs', () => {
  it('produces argv with -d, -P, -F, session/window names, env, and -- before the shell', () => {
    const args = buildTmuxNewWindowArgs({
      sessionName: 'sapling',
      windowName: 'spawn-1',
      env: { SAPLING_RUNNER: '1', FOO: 'bar' },
      command: 'echo hi',
    });
    expect(args).toEqual([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}\t#{pane_pid}',
      '-t',
      'sapling',
      '-n',
      'spawn-1',
      '-e',
      'SAPLING_RUNNER=1',
      '-e',
      'FOO=bar',
      '--',
      'bash',
      '-lc',
      'echo hi',
    ]);
  });

  it('preserves env values containing spaces and equals signs as a single -e arg', () => {
    const args = buildTmuxNewWindowArgs({
      sessionName: 's',
      windowName: 'w',
      env: { GREETING: 'hello world=!' },
      command: 'true',
    });
    expect(args).toContain('GREETING=hello world=!');
  });
});

const tmuxAvailable = (() => {
  if (!process.env.TMUX) return false;
  const r = spawnSync('tmux', ['display-message', '-p', '#{client_tty}'], { encoding: 'utf8' });
  return r.status === 0;
})();

describe.skipIf(!tmuxAvailable)('makeTmuxSpawner (live tmux)', () => {
  it('spawns a window, the pane pid exits, onExit resolves', async () => {
    // Use the current session, picked up by tmux from $TMUX.
    const sessionName = spawnSync('tmux', ['display-message', '-p', '#{session_name}'], {
      encoding: 'utf8',
    }).stdout.trim();
    const spawner = makeTmuxSpawner(sessionName);
    const child = spawner('true', { ...process.env });
    expect(child.pid).toBeGreaterThan(0);
    await child.onExit;
  }, 10_000);

  it('kill() runs tmux kill-window and reports success on the first call', async () => {
    const sessionName = spawnSync('tmux', ['display-message', '-p', '#{session_name}'], {
      encoding: 'utf8',
    }).stdout.trim();
    const spawner = makeTmuxSpawner(sessionName);
    const child = spawner('sleep 30', { ...process.env });
    // Give bash a moment to settle in the pane.
    await new Promise((r) => setTimeout(r, 200));
    expect(child.kill()).toBe(true);
    await child.onExit;
  }, 10_000);
});
