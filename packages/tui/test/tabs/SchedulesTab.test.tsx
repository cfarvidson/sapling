import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { makeFakeMcp, makeWorkItem } from '../helpers/fake-mcp.js';

const waitForFrame = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SchedulesTab via App', () => {
  it('groups schedules by enabled/disabled and shows cron in detail', async () => {
    const mcp = makeFakeMcp({
      work: [makeWorkItem({ id: 1 })],
      schedules: [
        {
          id: 100,
          name: 'daily ingest',
          source_type: 'app',
          app_id: 1,
          github_org: null,
          cron_expr: '0 9 * * *',
          timezone: 'UTC',
          overlap_policy: 'skip',
          title_template: 'Daily ingest',
          description_md: '',
          definition_of_done_md: '',
          enabled: true,
          last_fired_at: null,
          next_run_at: '2026-05-17T09:00:00Z',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
        {
          id: 101,
          name: 'archived weekly',
          source_type: 'github_org',
          app_id: 1,
          github_org: 'acme',
          cron_expr: '0 0 * * 0',
          timezone: 'UTC',
          overlap_policy: 'queue',
          title_template: 'Weekly',
          description_md: '',
          definition_of_done_md: '',
          enabled: false,
          last_fired_at: null,
          next_run_at: '2026-05-17T00:00:00Z',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      ],
    });
    const r = render(<App mcp={mcp} sessionName="sapling" />);
    await waitForFrame();
    r.stdin.write('4');
    await waitForFrame();
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('enabled (1)');
    expect(frame).toContain('disabled (1)');
    expect(frame).toContain('daily ingest');
    expect(frame).toContain('cron: 0 9 * * *');
    r.unmount();
  });
});
