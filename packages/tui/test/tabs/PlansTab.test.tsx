import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { makeFakeMcp, makeWorkItem } from '../helpers/fake-mcp.js';
import { makeFakeTmux } from '../helpers/fake-tmux.js';

const waitForFrame = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PlansTab via App', () => {
  it('renders plans grouped by status when activated with `2`', async () => {
    const mcp = makeFakeMcp({
      work: [makeWorkItem({ id: 1 })],
      plans: [
        {
          id: 10,
          title: 'plan alpha',
          status: 'active',
          service_id: null,
          parent_plan_id: null,
          project_id: null,
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
        {
          id: 11,
          title: 'plan beta',
          status: 'draft',
          service_id: null,
          parent_plan_id: null,
          project_id: null,
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      ],
    });
    const tmux = makeFakeTmux();
    const r = render(
      <App
        mcp={mcp}
        sessionName="sapling"
        listWindowsImpl={tmux.listWindows}
        switchToWorkWindowImpl={tmux.switchToWorkWindow}
        openEditorImpl={() => null}
      />,
    );
    await waitForFrame();
    r.stdin.write('2');
    await waitForFrame();
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('plan alpha');
    expect(frame).toContain('plan beta');
    expect(frame).toContain('active (1)');
    expect(frame).toContain('draft (1)');
    r.unmount();
  });

  it('does not fire work-tab action keys while on the plans tab', async () => {
    const mcp = makeFakeMcp({
      work: [makeWorkItem({ id: 1, status: 'blocked' })],
      plans: [
        {
          id: 10,
          title: 'plan alpha',
          status: 'active',
          service_id: null,
          parent_plan_id: null,
          project_id: null,
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      ],
    });
    const r = render(<App mcp={mcp} sessionName="sapling" openEditorImpl={() => 'reason'} />);
    await waitForFrame();
    r.stdin.write('2'); // switch to plans
    await waitForFrame();
    r.stdin.write('u'); // try unblock — should be ignored
    r.stdin.write('c'); // try cancel — should be ignored
    await waitForFrame();
    expect(mcp.calls.find((c) => c.method === 'unblockWork')).toBeUndefined();
    expect(mcp.calls.find((c) => c.method === 'cancelWork')).toBeUndefined();
    r.unmount();
  });
});
