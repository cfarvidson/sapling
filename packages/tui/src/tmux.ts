import { spawnSync } from 'node:child_process';

/**
 * One live tmux window in the Sapling session.
 *
 * `name` is what `tmux list-windows -F '#{window_name}'` reports. By
 * convention the Sapling runner spawns each agent with a transient
 * `spawn-<seq>` name; the `/sapling:work` skill renames the window to
 * `work-<id>` after `claim_next_work` succeeds. The TUI uses the renamed
 * form to correlate windows with `work_items` rows.
 */
export interface TmuxWindow {
  id: string;
  name: string;
}

/**
 * List all windows in `sessionName`. Returns `[]` if the session does not
 * exist, tmux is unavailable, or the command fails for any other reason —
 * the TUI treats live-window data as best-effort decoration.
 */
export function listWindows(sessionName: string): TmuxWindow[] {
  const r = spawnSync(
    'tmux',
    ['list-windows', '-t', sessionName, '-F', '#{window_id}\t#{window_name}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, ...rest] = line.split('\t');
      return { id, name: rest.join('\t') };
    });
}

/**
 * Find the live window name matching a given work id. Resolves `work-<id>`
 * (legacy un-suffixed name from PR #17's first cut) OR `work-<id>:<status>`
 * (status-aware naming from PR #17's revision). Returns the first match;
 * if both forms exist the suffixed form wins because it is the more recent
 * rename.
 */
export function findWorkWindowName(
  windows: ReadonlyArray<TmuxWindow>,
  workId: number,
): string | null {
  const prefix = `work-${workId}:`;
  const exact = `work-${workId}`;
  const suffixed = windows.find((w) => w.name.startsWith(prefix));
  if (suffixed) return suffixed.name;
  const legacy = windows.find((w) => w.name === exact);
  return legacy?.name ?? null;
}

/**
 * Switch the calling tmux client to a window whose name matches `work-<id>`
 * (or `work-<id>:<status>`) inside `sessionName`. Returns true when the
 * switch succeeded.
 *
 * Phase-1 attach: the TUI itself is expected to run inside the same tmux
 * session, so `switch-client` is enough — no separate `attach` step is
 * needed. If the TUI runs outside tmux (uncommon), this is a no-op and the
 * caller should fall back to a printable target string.
 */
export function switchToWorkWindow(sessionName: string, workId: number): boolean {
  if (!process.env.TMUX) return false;
  const windows = listWindows(sessionName);
  const name = findWorkWindowName(windows, workId);
  if (!name) return false;
  const r = spawnSync('tmux', ['switch-client', '-t', `${sessionName}:${name}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}
