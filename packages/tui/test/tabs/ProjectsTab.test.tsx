import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { makeFakeMcp, makeWorkItem } from '../helpers/fake-mcp.js';

const waitForFrame = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ProjectsTab via App', () => {
  it('renders projects with app and status info when activated with `3`', async () => {
    const mcp = makeFakeMcp({
      work: [makeWorkItem({ id: 1 })],
      projects: [
        {
          id: 7,
          title: 'Iris ingestion rewrite',
          status: 'in_progress',
          app_id: 1,
          app_name: 'iris',
          linear_url: null,
          dod_cycle_count: 0,
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      ],
    });
    const r = render(<App mcp={mcp} sessionName="sapling" />);
    await waitForFrame();
    r.stdin.write('3');
    await waitForFrame();
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Iris ingestion rewrite');
    expect(frame).toContain('in_progress');
    expect(frame).toContain('app: iris');
    r.unmount();
  });
});
