import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type { McpClient, Plan } from 'sapling-mcp-client';
import { useReportFlatOrder } from './useReportFlatOrder.js';

const POLL_MS = 2000;

const PLAN_STATUS_ORDER = ['draft', 'active', 'completed', 'archived'] as const;

interface PlansTabProps {
  mcp: McpClient;
  filter: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onFlatOrder: (ids: number[]) => void;
}

function matchesFilter(plan: Plan, filter: string): boolean {
  if (filter.length === 0) return true;
  return plan.title.toLowerCase().includes(filter.toLowerCase());
}

function groupByStatus(plans: Plan[]): Map<string, Plan[]> {
  const map = new Map<string, Plan[]>();
  for (const status of PLAN_STATUS_ORDER) map.set(status, []);
  for (const p of plans) {
    const bucket = map.get(p.status) ?? [];
    bucket.push(p);
    map.set(p.status, bucket);
  }
  return map;
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'active':
      return 'cyan';
    case 'draft':
      return 'yellow';
    case 'completed':
      return 'green';
    case 'archived':
      return 'gray';
    default:
      return 'white';
  }
}

/**
 * Read-only view over plans. Polls `list_plans` on a 2s interval, groups by
 * status, and renders the same two-pane shape as the work tab.
 */
export function PlansTab({
  mcp,
  filter,
  selectedId,
  onSelect,
  onFlatOrder,
}: PlansTabProps): React.ReactElement {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const rows = await mcp.listPlans();
        if (!cancelled) {
          setPlans(rows);
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

  const filtered = useMemo(() => plans.filter((p) => matchesFilter(p, filter)), [plans, filter]);
  const grouped = useMemo(() => groupByStatus(filtered), [filtered]);
  const flatOrder = useMemo(() => {
    const order: number[] = [];
    for (const s of PLAN_STATUS_ORDER) for (const p of grouped.get(s) ?? []) order.push(p.id);
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

  const selected = selectedId === null ? null : (plans.find((p) => p.id === selectedId) ?? null);

  return (
    <Box flexGrow={1}>
      {error && <Text color="red">{error}</Text>}
      <Box flexDirection="column" width="40%" paddingRight={1}>
        {PLAN_STATUS_ORDER.map((status) => {
          const items = grouped.get(status) ?? [];
          if (items.length === 0 && status === 'archived') return null;
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
            <Text>
              status: <Text color={colorForStatus(selected.status)}>{selected.status}</Text>
            </Text>
            {selected.service_id && <Text dimColor>service: #{selected.service_id}</Text>}
            {selected.project_id && <Text dimColor>project: #{selected.project_id}</Text>}
            {selected.parent_plan_id && (
              <Text dimColor>parent: plan #{selected.parent_plan_id}</Text>
            )}
            <Text dimColor>created: {selected.created_at}</Text>
            <Text dimColor>updated: {selected.updated_at}</Text>
          </>
        ) : (
          <Text dimColor>no plans</Text>
        )}
      </Box>
    </Box>
  );
}
