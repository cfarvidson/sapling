import type { TmuxWindow } from '../../src/tmux.js';

/**
 * Settable tmux-window store used by tests. Replaces the production
 * `listWindows()` shell-out so tests can simulate the runner spawning,
 * renaming, or closing windows without a real tmux server.
 */
export interface FakeTmux {
  windows: TmuxWindow[];
  setWindows: (next: TmuxWindow[]) => void;
  listWindows: (sessionName: string) => TmuxWindow[];
  switchedTo: string[];
  switchToWorkWindow: (sessionName: string, workId: number) => boolean;
}

export function makeFakeTmux(initial: TmuxWindow[] = []): FakeTmux {
  const state: FakeTmux = {
    windows: initial,
    setWindows(next) {
      state.windows = next;
    },
    listWindows() {
      return state.windows.slice();
    },
    switchedTo: [],
    switchToWorkWindow(sessionName, workId) {
      const match = state.windows.find(
        (w) => w.name === `work-${workId}` || w.name.startsWith(`work-${workId}:`),
      );
      if (!match) return false;
      state.switchedTo.push(`${sessionName}:${match.name}`);
      return true;
    },
  };
  return state;
}
