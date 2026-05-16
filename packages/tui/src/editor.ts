import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Open the user's `$EDITOR` (or `vi` as a fallback) on a temp file pre-seeded
 * with `initial`, block until they exit, and return the resulting contents
 * minus trailing whitespace. Returns `null` if the editor exited non-zero or
 * if the file was left unchanged — both treated as "user cancelled."
 *
 * Used by `provide_human_input` so the user gets a real editor for multi-line
 * markdown instead of typing into a one-line Ink prompt.
 */
export function openEditor(initial = ''): string | null {
  const editor = process.env.EDITOR?.trim() || 'vi';
  const dir = mkdtempSync(join(tmpdir(), 'sapling-tui-'));
  const path = join(dir, 'EDIT_MSG.md');
  try {
    writeFileSync(path, initial, 'utf8');
    const r = spawnSync(editor, [path], { stdio: 'inherit' });
    if (r.status !== 0) return null;
    const content = readFileSync(path, 'utf8').replace(/\s+$/u, '');
    if (content === initial.replace(/\s+$/u, '')) return null;
    return content;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
