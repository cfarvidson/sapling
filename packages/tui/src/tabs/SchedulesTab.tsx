import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type { McpClient, Schedule } from 'sapling-mcp-client';
import { useReportFlatOrder } from './useReportFlatOrder.js';

const POLL_MS = 2000;

interface SchedulesTabProps {
  mcp: McpClient;
  filter: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onFlatOrder: (ids: number[]) => void;
}

function matchesFilter(s: Schedule, filter: string): boolean {
  if (filter.length === 0) return true;
  const needle = filter.toLowerCase();
  return s.name.toLowerCase().includes(needle) || s.cron_expr.toLowerCase().includes(needle);
}

export function SchedulesTab({
  mcp,
  filter,
  selectedId,
  onSelect,
  onFlatOrder,
}: SchedulesTabProps): React.ReactElement {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const rows = await mcp.listSchedules();
        if (!cancelled) {
          setSchedules(rows);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mcp]);

  const filtered = useMemo(
    () => schedules.filter((s) => matchesFilter(s, filter)),
    [schedules, filter],
  );

  // Group by enabled/disabled — schedules don't carry status the way work
  // items do; enabled is the primary operator-visible attribute.
  const enabled = filtered.filter((s) => s.enabled);
  const disabled = filtered.filter((s) => !s.enabled);

  const flatOrder = useMemo(
    () => [...enabled.map((s) => s.id), ...disabled.map((s) => s.id)],
    [enabled, disabled],
  );

  useReportFlatOrder(flatOrder, onFlatOrder);

  useEffect(() => {
    if (flatOrder.length === 0) {
      if (selectedId !== null) onSelect(null);
      return;
    }
    if (selectedId === null || !flatOrder.includes(selectedId)) onSelect(flatOrder[0]);
  }, [flatOrder, selectedId, onSelect]);

  const selected =
    selectedId === null ? null : (schedules.find((s) => s.id === selectedId) ?? null);

  return (
    <Box flexGrow={1}>
      {error && <Text color="red">{error}</Text>}
      <Box flexDirection="column" width="40%" paddingRight={1}>
        <Text color="cyan">enabled ({enabled.length})</Text>
        {enabled.map((s) => (
          <Text key={s.id} inverse={s.id === selectedId}>
            {s.id === selectedId ? '▸ ' : '  '}#{s.id} {s.name}
          </Text>
        ))}
        <Text color="gray">disabled ({disabled.length})</Text>
        {disabled.map((s) => (
          <Text key={s.id} inverse={s.id === selectedId}>
            {s.id === selectedId ? '▸ ' : '  '}#{s.id} {s.name}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {selected ? (
          <>
            <Text bold>
              #{selected.id} {selected.name}
            </Text>
            <Text dimColor>
              source: {selected.source_type}
              {selected.github_org ? ` (${selected.github_org})` : ''}
            </Text>
            <Text dimColor>
              cron: {selected.cron_expr} ({selected.timezone})
            </Text>
            <Text dimColor>overlap_policy: {selected.overlap_policy}</Text>
            <Text>
              enabled:{' '}
              <Text color={selected.enabled ? 'green' : 'gray'}>
                {selected.enabled ? 'yes' : 'no'}
              </Text>
            </Text>
            <Text dimColor>next_run_at: {selected.next_run_at}</Text>
            {selected.last_fired_at && (
              <Text dimColor>last_fired_at: {selected.last_fired_at}</Text>
            )}
            <Box marginTop={1} flexDirection="column">
              <Text bold>title template</Text>
              <Text>{selected.title_template}</Text>
            </Box>
          </>
        ) : (
          <Text dimColor>no schedules</Text>
        )}
      </Box>
    </Box>
  );
}
