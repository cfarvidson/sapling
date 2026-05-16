import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { makeFakeMcp, makeWorkItem } from './helpers/fake-mcp.js';
import { makeFakeTmux } from './helpers/fake-tmux.js';

const waitForFrame = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderApp(opts?: {
  work?: ReturnType<typeof makeWorkItem>[];
  windows?: { id: string; name: string }[];
  openEditor?: () => string | null;
}) {
  const mcp = makeFakeMcp({ work: opts?.work ?? [] });
  const tmux = makeFakeTmux(opts?.windows ?? []);
  const openEditorImpl = opts?.openEditor ?? ((): string | null => null);
  const r = render(
    <App
      mcp={mcp}
      sessionName="sapling"
      listWindowsImpl={tmux.listWindows}
      switchToWorkWindowImpl={tmux.switchToWorkWindow}
      openEditorImpl={openEditorImpl}
    />,
  );
  return { mcp, tmux, ...r };
}

describe('App — read-only behavior', () => {
  it('renders status groups with the correct counts', async () => {
    const { lastFrame, unmount } = renderApp({
      work: [
        makeWorkItem({ id: 1, status: 'claimed', title: 'claimed one' }),
        makeWorkItem({ id: 2, status: 'pending', title: 'pending one' }),
        makeWorkItem({ id: 3, status: 'pending', title: 'pending two' }),
        makeWorkItem({ id: 4, status: 'failed', title: 'broken' }),
      ],
    });
    await waitForFrame();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('claimed (1)');
    expect(frame).toContain('pending (2)');
    expect(frame).toContain('failed (1)');
    expect(frame).toContain('claimed one');
    expect(frame).toContain('broken');
    unmount();
  });

  it('shows the live ● marker for claimed items with a matching tmux window', async () => {
    const { lastFrame, unmount } = renderApp({
      work: [makeWorkItem({ id: 7, status: 'claimed' })],
      windows: [{ id: '@1', name: 'work-7' }],
    });
    await waitForFrame();
    expect(lastFrame() ?? '').toMatch(/#7.*●/);
    unmount();
  });

  it('matches status-suffixed window names (work-<id>:<status>) for the live marker', async () => {
    const { lastFrame, unmount } = renderApp({
      work: [makeWorkItem({ id: 11, status: 'claimed' })],
      windows: [{ id: '@1', name: 'work-11:claimed' }],
    });
    await waitForFrame();
    expect(lastFrame() ?? '').toMatch(/#11.*●/);
    expect(lastFrame() ?? '').toContain('sapling:work-11:claimed');
    unmount();
  });

  it('shows "no work items" detail message when the queue is empty', async () => {
    const { lastFrame, unmount } = renderApp({ work: [] });
    await waitForFrame();
    expect(lastFrame() ?? '').toContain('no work items in the queue');
    unmount();
  });
});

describe('App — navigation', () => {
  it('moves selection with ↓ and j', async () => {
    const { lastFrame, stdin, unmount } = renderApp({
      work: [
        makeWorkItem({ id: 1, status: 'claimed', title: 'first' }),
        makeWorkItem({ id: 2, status: 'pending', title: 'second' }),
      ],
    });
    await waitForFrame();
    // initial selection: #1
    expect(lastFrame() ?? '').toContain('▸ #1');
    stdin.write('j');
    await waitForFrame();
    expect(lastFrame() ?? '').toContain('▸ #2');
    unmount();
  });
});

describe('App — attach gating', () => {
  it('switches to the work window when → is pressed on a claimed item with a live window', async () => {
    const { tmux, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 42, status: 'claimed' })],
      windows: [{ id: '@1', name: 'work-42' }],
    });
    await waitForFrame();
    stdin.write('[C'); // right arrow
    await waitForFrame();
    expect(tmux.switchedTo).toContain('sapling:work-42');
    unmount();
  });

  it('does not switch when the selected item is not claimed', async () => {
    const { tmux, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 9, status: 'pending' })],
      windows: [{ id: '@1', name: 'work-9' }],
    });
    await waitForFrame();
    stdin.write('[C');
    await waitForFrame();
    expect(tmux.switchedTo).toHaveLength(0);
    unmount();
  });
});

describe('App — action keys', () => {
  it('fires unblockWork when `u` is confirmed on a blocked item', async () => {
    const { mcp, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 3, status: 'blocked' })],
    });
    await waitForFrame(80);
    stdin.write('u');
    await waitForFrame();
    stdin.write('y');
    await waitForFrame(80);
    expect(mcp.calls.find((c) => c.method === 'unblockWork')).toMatchObject({
      method: 'unblockWork',
      args: [3],
    });
    unmount();
  });

  it('fires cancelWork with the editor-captured reason when `c` is pressed', async () => {
    const { mcp, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 5, status: 'claimed' })],
      openEditor: () => 'no longer needed',
    });
    await waitForFrame();
    stdin.write('c');
    await waitForFrame(60);
    expect(mcp.calls.find((c) => c.method === 'cancelWork')).toMatchObject({
      method: 'cancelWork',
      args: [5, 'no longer needed'],
    });
    unmount();
  });

  it('does NOT fire cancelWork when the editor returns empty', async () => {
    const { mcp, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 5, status: 'claimed' })],
      openEditor: () => null,
    });
    await waitForFrame();
    stdin.write('c');
    await waitForFrame(60);
    expect(mcp.calls.find((c) => c.method === 'cancelWork')).toBeUndefined();
    unmount();
  });

  it('fires retryWork with after_ms when the prompt receives digits', async () => {
    const { mcp, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 8, status: 'failed' })],
    });
    await waitForFrame();
    stdin.write('r');
    await waitForFrame();
    stdin.write('500');
    stdin.write('\r');
    await waitForFrame(60);
    expect(mcp.calls.find((c) => c.method === 'retryWork')).toMatchObject({
      method: 'retryWork',
      args: [8, 500],
    });
    unmount();
  });

  it('fires retryWork without after_ms on empty submit', async () => {
    const { mcp, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 9, status: 'failed' })],
    });
    await waitForFrame();
    stdin.write('r');
    await waitForFrame();
    stdin.write('\r');
    await waitForFrame(60);
    expect(mcp.calls.find((c) => c.method === 'retryWork')).toMatchObject({
      method: 'retryWork',
      args: [9, undefined],
    });
    unmount();
  });
});

describe('App — tab switching', () => {
  it('renders the tab strip with the work tab selected by default', async () => {
    const { lastFrame, unmount } = renderApp({ work: [makeWorkItem({ id: 1 })] });
    await waitForFrame();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1:work');
    expect(frame).toContain('2:plans');
    expect(frame).toContain('3:projects');
    expect(frame).toContain('4:schedules');
    unmount();
  });

  it('switches to the plans tab on `2` and back on `1`', async () => {
    const { lastFrame, stdin, mcp, unmount } = renderApp({
      work: [makeWorkItem({ id: 1, title: 'work item' })],
    });
    mcp.setPlans([
      {
        id: 99,
        title: 'a plan',
        status: 'active',
        service_id: null,
        parent_plan_id: null,
        project_id: null,
        created_at: '2026-05-16T00:00:00Z',
        updated_at: '2026-05-16T00:00:00Z',
      },
    ]);
    await waitForFrame();
    stdin.write('2');
    await waitForFrame();
    expect(lastFrame() ?? '').toContain('a plan');
    stdin.write('1');
    await waitForFrame();
    expect(lastFrame() ?? '').toContain('work item');
    unmount();
  });
});

describe('App — filter and help overlay', () => {
  it('narrows the visible list when a filter is set', async () => {
    const { lastFrame, stdin, unmount } = renderApp({
      work: [
        makeWorkItem({ id: 1, status: 'pending', title: 'build search index' }),
        makeWorkItem({ id: 2, status: 'pending', title: 'fix import path' }),
      ],
    });
    await waitForFrame();
    stdin.write('/');
    await waitForFrame();
    stdin.write('search');
    stdin.write('\r');
    await waitForFrame();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('build search index');
    expect(frame).not.toContain('fix import path');
    unmount();
  });

  it('toggles the help overlay with `?`', async () => {
    const { lastFrame, stdin, unmount } = renderApp({
      work: [makeWorkItem({ id: 1 })],
    });
    await waitForFrame();
    expect(lastFrame() ?? '').not.toContain('Sapling TUI — key bindings');
    stdin.write('?');
    await waitForFrame();
    expect(lastFrame() ?? '').toContain('Sapling TUI — key bindings');
    stdin.write('?');
    await waitForFrame();
    expect(lastFrame() ?? '').not.toContain('Sapling TUI — key bindings');
    unmount();
  });
});
