import { spawnSync } from 'node:child_process';

/**
 * Pure helper that classifies tmux window names into "ours" (windows this
 * runner spawned) vs "foreign" (anything else that matches the
 * `work-<n>[:<status>]` pattern).
 *
 * Foreign windows are evidence that another runner — or an unclean previous
 * run — owns work in the same tmux session. We do not abort the runner; the
 * cost of a stuck runner that refuses to start is higher than the cost of
 * trampling. We just warn.
 *
 * The matcher is intentionally permissive: `work-42`, `work-42:claimed`,
 * `work-42:awaiting_input`, etc. all count as work windows. Anything else
 * (`runner`, `tui`, `spawn-7`) is ignored.
 */
export function detectForeignWindows(
  currentWindowNames: ReadonlyArray<string>,
  ownNames: ReadonlyArray<string>,
): string[] {
  const own = new Set(ownNames);
  return currentWindowNames.filter((name) => /^work-\d+(:.*)?$/.test(name) && !own.has(name));
}

/**
 * Best-effort `tmux list-windows -F '#{window_name}'`. Returns an empty
 * array on any failure — tmux being absent or the session not existing is
 * not a startup error; the runner just won't have a session to warn about.
 */
export function listSessionWindowNames(sessionName: string): string[] {
  const r = spawnSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_name}'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
