import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type { McpClient, Project } from 'sapling-mcp-client';
import { useReportFlatOrder } from './useReportFlatOrder.js';

const POLL_MS = 2000;

const PROJECT_STATUS_ORDER = [
  'in_progress',
  'scoping',
  'pending',
  'blocked',
  'done',
  'cancelled',
] as const;

interface ProjectsTabProps {
  mcp: McpClient;
  filter: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onFlatOrder: (ids: number[]) => void;
}

function matchesFilter(p: Project, filter: string): boolean {
  if (filter.length === 0) return true;
  const needle = filter.toLowerCase();
  return p.title.toLowerCase().includes(needle) || p.app_name.toLowerCase().includes(needle);
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'in_progress':
      return 'cyan';
    case 'scoping':
    case 'pending':
      return 'yellow';
    case 'blocked':
      return 'red';
    case 'done':
      return 'green';
    case 'cancelled':
      return 'gray';
    default:
      return 'white';
  }
}

export function ProjectsTab({
  mcp,
  filter,
  selectedId,
  onSelect,
  onFlatOrder,
}: ProjectsTabProps): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const rows = await mcp.listProjects();
        if (!cancelled) {
          setProjects(rows);
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
    () => projects.filter((p) => matchesFilter(p, filter)),
    [projects, filter],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const status of PROJECT_STATUS_ORDER) map.set(status, []);
    for (const p of filtered) {
      const bucket = map.get(p.status) ?? [];
      bucket.push(p);
      map.set(p.status, bucket);
    }
    return map;
  }, [filtered]);

  const flatOrder = useMemo(() => {
    const order: number[] = [];
    for (const s of PROJECT_STATUS_ORDER) for (const p of grouped.get(s) ?? []) order.push(p.id);
    return order;
  }, [grouped]);

  useReportFlatOrder(flatOrder, onFlatOrder);

  useEffect(() => {
    if (flatOrder.length === 0) {
      if (selectedId !== null) onSelect(null);
      return;
    }
    if (selectedId === null || !flatOrder.includes(selectedId)) onSelect(flatOrder[0]);
  }, [flatOrder, selectedId, onSelect]);

  const selected = selectedId === null ? null : (projects.find((p) => p.id === selectedId) ?? null);

  return (
    <Box flexGrow={1}>
      {error && <Text color="red">{error}</Text>}
      <Box flexDirection="column" width="40%" paddingRight={1}>
        {PROJECT_STATUS_ORDER.map((status) => {
          const items = grouped.get(status) ?? [];
          if (
            items.length === 0 &&
            status !== 'in_progress' &&
            status !== 'pending' &&
            status !== 'scoping'
          )
            return null;
          return (
            <Box key={status} flexDirection="column">
              <Text color={colorForStatus(status)}>
                {status} ({items.length})
              </Text>
              {items.map((p) => (
                <Text key={p.id} inverse={p.id === selectedId}>
                  {p.id === selectedId ? '▸ ' : '  '}#{p.id} {p.title}
                </Text>
              ))}
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {selected ? (
          <>
            <Text bold>
              #{selected.id} {selected.title}
            </Text>
            <Text dimColor>app: {selected.app_name}</Text>
            <Text>
              status: <Text color={colorForStatus(selected.status)}>{selected.status}</Text>
            </Text>
            {selected.linear_url && <Text dimColor>linear: {selected.linear_url}</Text>}
            <Text dimColor>dod_cycle_count: {selected.dod_cycle_count}</Text>
            <Text dimColor>created: {selected.created_at}</Text>
            <Text dimColor>updated: {selected.updated_at}</Text>
          </>
        ) : (
          <Text dimColor>no projects</Text>
        )}
      </Box>
    </Box>
  );
}
