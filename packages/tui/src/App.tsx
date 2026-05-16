import { Box, Text, useApp, useInput, useStdin } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Artifact, McpClient, WorkItemDetail } from 'sapling-mcp-client';
import { HelpOverlay } from './components/HelpOverlay.js';
import { PromptInput } from './components/PromptInput.js';
import { openEditor } from './editor.js';
import { PlansTab } from './tabs/PlansTab.js';
import { ProjectsTab } from './tabs/ProjectsTab.js';
import { SchedulesTab } from './tabs/SchedulesTab.js';
import {
  listWindows as defaultListWindows,
  switchToWorkWindow as defaultSwitchToWorkWindow,
  type TmuxWindow,
} from './tmux.js';

type TabName = 'work' | 'plans' | 'projects' | 'schedules';

type PendingAction =
  | { kind: 'unblock'; workId: number }
  | { kind: 'retry'; workId: number; afterMs?: number }
  | { kind: 'cancel'; workId: number; reason: string }
  | { kind: 'input'; workId: number };

type Prompt = { kind: 'retry-delay'; workId: number } | { kind: 'filter' };

function hasLiveWindow(windowByName: Map<string, TmuxWindow>, workId: number): boolean {
  const exact = `work-${workId}`;
  const prefix = `work-${workId}:`;
  if (windowByName.has(exact)) return true;
  for (const name of windowByName.keys()) if (name.startsWith(prefix)) return true;
  return false;
}

function matchesFilter(item: WorkItemDetail, filter: string): boolean {
  if (filter.length === 0) return true;
  const needle = filter.toLowerCase();
  const haystack = `${item.title} ${item.app_name ?? ''} ${item.team_name ?? ''}`.toLowerCase();
  return haystack.includes(needle);
}

const STATUS_ORDER = [
  'claimed',
  'awaiting_input',
  'pending',
  'blocked',
  'failed',
  'complete',
  'cancelled',
] as const;

const POLL_MS = 1500;

interface AppProps {
  mcp: McpClient;
  sessionName: string;
  /** Injectable for tests; defaults to the real tmux helper. */
  listWindowsImpl?: typeof defaultListWindows;
  /** Injectable for tests; defaults to the real tmux helper. */
  switchToWorkWindowImpl?: typeof defaultSwitchToWorkWindow;
  /** Injectable for tests; defaults to opening $EDITOR. Return the captured text or null. */
  openEditorImpl?: (initial?: string) => string | null;
}

interface PollState {
  work: WorkItemDetail[];
  windows: TmuxWindow[];
  error: string | null;
  lastTick: Date | null;
}

/**
 * Top-level TUI. Holds the polled queue + tmux state, the selection cursor,
 * and renders the two-pane layout (status groups left, detail right).
 *
 * Phase-1 surface: read + navigate + attach (→/enter). Mutating actions
 * (unblock/retry/cancel/provide_human_input) land in PR #5 alongside the
 * `make tui` Makefile target.
 */
export function App({
  mcp,
  sessionName,
  listWindowsImpl = defaultListWindows,
  switchToWorkWindowImpl = defaultSwitchToWorkWindow,
  openEditorImpl = openEditor,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [poll, setPoll] = useState<PollState>({
    work: [],
    windows: [],
    error: null,
    lastTick: null,
  });
  const [detailArtifacts, setDetailArtifacts] = useState<Artifact[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [activeTab, setActiveTab] = useState<TabName>('work');
  // Each tab owns its own selection cursor + flat order. Storing them
  // top-level means switching tabs preserves where you were and the global
  // ↑/↓ handler can dispatch to the right list.
  const [tabSelection, setTabSelection] = useState<Record<TabName, number | null>>({
    work: null,
    plans: null,
    projects: null,
    schedules: null,
  });
  const [tabFlatOrder, setTabFlatOrder] = useState<Record<TabName, number[]>>({
    work: [],
    plans: [],
    projects: [],
    schedules: [],
  });
  const { setRawMode } = useStdin();
  const selectedId = tabSelection[activeTab];
  const setSelectedTabId = useCallback(
    (id: number | null): void => setTabSelection((prev) => ({ ...prev, [activeTab]: id })),
    [activeTab],
  );
  const setPlansSelection = useCallback(
    (id: number | null) => setTabSelection((prev) => ({ ...prev, plans: id })),
    [],
  );
  const setProjectsSelection = useCallback(
    (id: number | null) => setTabSelection((prev) => ({ ...prev, projects: id })),
    [],
  );
  const setSchedulesSelection = useCallback(
    (id: number | null) => setTabSelection((prev) => ({ ...prev, schedules: id })),
    [],
  );
  const setPlansOrder = useCallback(
    (ids: number[]) => setTabFlatOrder((prev) => ({ ...prev, plans: ids })),
    [],
  );
  const setProjectsOrder = useCallback(
    (ids: number[]) => setTabFlatOrder((prev) => ({ ...prev, projects: ids })),
    [],
  );
  const setSchedulesOrder = useCallback(
    (ids: number[]) => setTabFlatOrder((prev) => ({ ...prev, schedules: ids })),
    [],
  );

  // Polling loop: list_work + tmux list-windows every POLL_MS. tmux errors
  // are swallowed by listWindows() because the TUI must keep rendering even
  // when no session exists yet (e.g. user opened sapling-tui standalone).
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const work = await mcp.listWork();
        if (cancelled) return;
        const windows = listWindowsImpl(sessionName);
        setPoll({ work, windows, error: null, lastTick: new Date() });
      } catch (err) {
        if (cancelled) return;
        setPoll((prev) => ({ ...prev, error: String(err) }));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mcp, sessionName]);

  const filteredWork = useMemo(
    () => poll.work.filter((item) => matchesFilter(item, filter)),
    [poll.work, filter],
  );
  const grouped = useMemo(() => groupByStatus(filteredWork), [filteredWork]);
  const flatOrder = useMemo(() => flattenForCursor(grouped), [grouped]);

  // Keep the work tab's selection valid as the queue changes underneath us.
  // If the selected id disappeared from the queue (e.g. work completed and
  // dropped off), fall back to the first row of the first non-empty group.
  useEffect(() => {
    setTabFlatOrder((prev) => ({ ...prev, work: flatOrder }));
  }, [flatOrder]);
  useEffect(() => {
    const workSelectedId = tabSelection.work;
    if (flatOrder.length === 0) {
      if (workSelectedId !== null) setTabSelection((prev) => ({ ...prev, work: null }));
      return;
    }
    if (workSelectedId === null || !flatOrder.includes(workSelectedId)) {
      setTabSelection((prev) => ({ ...prev, work: flatOrder[0] }));
    }
  }, [flatOrder, tabSelection.work]);

  // Fetch artifacts for the selected item. Debounce isn't strictly needed
  // at POLL_MS cadence, but we keep the fetch keyed on id to avoid a stale
  // response overwriting a newer selection.
  useEffect(() => {
    if (selectedId === null) {
      setDetailArtifacts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const arts = await mcp.listArtifacts({ work_item_id: selectedId });
        if (!cancelled) setDetailArtifacts(arts);
      } catch {
        if (!cancelled) setDetailArtifacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mcp, selectedId]);

  const runAction = useCallback(
    async (action: PendingAction): Promise<void> => {
      setBusy(true);
      try {
        if (action.kind === 'unblock') {
          await mcp.unblockWork(action.workId);
          setActionFeedback(`unblocked #${action.workId}`);
        } else if (action.kind === 'retry') {
          await mcp.retryWork(action.workId, action.afterMs);
          setActionFeedback(
            action.afterMs
              ? `retried #${action.workId} (delay ${action.afterMs}ms)`
              : `retried #${action.workId}`,
          );
        } else if (action.kind === 'cancel') {
          await mcp.cancelWork(action.workId, action.reason);
          setActionFeedback(`cancelled #${action.workId}`);
        } else if (action.kind === 'input') {
          // Hand the TTY to $EDITOR. Ink keeps stdin in raw mode by default;
          // we drop out of raw mode so vi/emacs/$EDITOR can read keystrokes
          // normally, then restore raw mode so navigation keeps working.
          setRawMode(false);
          const answer = openEditorImpl('');
          setRawMode(true);
          if (answer && answer.trim().length > 0) {
            await mcp.provideHumanInput(action.workId, answer);
            setActionFeedback(`answered #${action.workId}`);
          } else {
            setActionFeedback('input cancelled');
          }
        }
      } catch (err) {
        setActionFeedback(`error: ${String(err)}`);
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [mcp, setRawMode],
  );

  useInput((input, key) => {
    if (busy) return;
    if (prompt) return; // PromptInput owns the keyboard while open
    if (showHelp) {
      if (input === '?' || key.escape || input === 'q') setShowHelp(false);
      return;
    }
    if (pending) {
      if (input === 'y' || key.return) {
        void runAction(pending);
        return;
      }
      if (input === 'n' || key.escape || input === 'q') {
        setPending(null);
        setActionFeedback('cancelled');
        return;
      }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === '?') {
      setShowHelp(true);
      return;
    }
    if (input === '/') {
      setPrompt({ kind: 'filter' });
      return;
    }
    if (input === '1') {
      setActiveTab('work');
      return;
    }
    if (input === '2') {
      setActiveTab('plans');
      return;
    }
    if (input === '3') {
      setActiveTab('projects');
      return;
    }
    if (input === '4') {
      setActiveTab('schedules');
      return;
    }
    const activeFlatOrder = tabFlatOrder[activeTab];
    if (key.upArrow || input === 'k') {
      moveCursor(activeFlatOrder, selectedId, -1, setSelectedTabId);
      return;
    }
    if (key.downArrow || input === 'j') {
      moveCursor(activeFlatOrder, selectedId, +1, setSelectedTabId);
      return;
    }
    // The remaining keys (→, u/r/c/i) act on work items only.
    if (activeTab !== 'work') return;
    if (key.rightArrow || key.return) {
      if (selectedId !== null) {
        const item = poll.work.find((w) => w.id === selectedId);
        if (item && item.status === 'claimed') {
          switchToWorkWindowImpl(sessionName, item.id);
        }
      }
      return;
    }
    if (selectedId === null) return;
    const item = poll.work.find((w) => w.id === selectedId);
    if (!item) return;
    if (input === 'u' && item.status === 'blocked') {
      setPending({ kind: 'unblock', workId: item.id });
    } else if (input === 'r') {
      setPrompt({ kind: 'retry-delay', workId: item.id });
    } else if (input === 'c') {
      // Cancel asks for a reason via $EDITOR (same TTY handoff as `i`). Empty
      // buffer aborts the cancel — useful "cancel my cancel" path.
      setBusy(true);
      setRawMode(false);
      const reason = openEditorImpl('');
      setRawMode(true);
      setBusy(false);
      if (reason && reason.trim().length > 0) {
        void runAction({ kind: 'cancel', workId: item.id, reason });
      } else {
        setActionFeedback('cancel aborted');
      }
    } else if (input === 'i' && item.status === 'awaiting_input') {
      // Editor flow doesn't need a confirm step — opening $EDITOR is itself
      // a destructive-feeling action that the user can still cancel by
      // closing the editor with an empty buffer.
      void runAction({ kind: 'input', workId: item.id });
    }
  });

  const selected =
    selectedId === null ? null : (poll.work.find((w) => w.id === selectedId) ?? null);
  const windowByName = useMemo(() => {
    const map = new Map<string, TmuxWindow>();
    for (const w of poll.windows) map.set(w.name, w);
    return map;
  }, [poll.windows]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Sapling </Text>
        <Text dimColor>
          session={sessionName}{' '}
          {poll.lastTick ? `polled ${poll.lastTick.toLocaleTimeString()}` : 'connecting…'}
        </Text>
        {filter.length > 0 && <Text color="cyan"> filter=&quot;{filter}&quot;</Text>}
      </Box>
      <Box>
        {(['work', 'plans', 'projects', 'schedules'] as const).map((tab, i) => (
          <Text
            key={tab}
            bold={tab === activeTab}
            color={tab === activeTab ? 'cyan' : undefined}
            dimColor={tab !== activeTab}
          >
            {' '}
            {i + 1}:{tab}{' '}
          </Text>
        ))}
      </Box>
      {poll.error && (
        <Box>
          <Text color="red">{poll.error}</Text>
        </Box>
      )}
      {activeTab === 'work' && (
        <Box flexGrow={1}>
          <Box flexDirection="column" width="40%" paddingRight={1}>
            {STATUS_ORDER.map((status) => {
              const items = grouped.get(status) ?? [];
              if (items.length === 0 && status !== 'claimed' && status !== 'pending') return null;
              return (
                <Box key={status} flexDirection="column">
                  <Text color={colorForStatus(status)}>
                    {status} ({items.length})
                  </Text>
                  {items.map((item) => {
                    const isSelected = item.id === selectedId;
                    const live = hasLiveWindow(windowByName, item.id);
                    const marker = isSelected ? '▸ ' : '  ';
                    return (
                      <Text key={item.id} inverse={isSelected}>
                        {marker}#{item.id} {truncate(item.title, 24)} {live ? '●' : ' '}
                      </Text>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
          <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
            <Detail
              item={selected}
              artifacts={detailArtifacts}
              sessionName={sessionName}
              windowByName={windowByName}
            />
          </Box>
        </Box>
      )}
      {activeTab === 'plans' && (
        <PlansTab
          mcp={mcp}
          filter={filter}
          selectedId={tabSelection.plans}
          onSelect={setPlansSelection}
          onFlatOrder={setPlansOrder}
        />
      )}
      {activeTab === 'projects' && (
        <ProjectsTab
          mcp={mcp}
          filter={filter}
          selectedId={tabSelection.projects}
          onSelect={setProjectsSelection}
          onFlatOrder={setProjectsOrder}
        />
      )}
      {activeTab === 'schedules' && (
        <SchedulesTab
          mcp={mcp}
          filter={filter}
          selectedId={tabSelection.schedules}
          onSelect={setSchedulesSelection}
          onFlatOrder={setSchedulesOrder}
        />
      )}
      {pending && (
        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text>
            <Text bold color="yellow">
              {pending.kind}
            </Text>{' '}
            work #{pending.workId}? <Text dimColor>(y / n)</Text>
          </Text>
        </Box>
      )}
      {prompt?.kind === 'retry-delay' && (
        <PromptInput
          label={`retry #${prompt.workId} — delay in ms (blank = immediate):`}
          mode="digits"
          onSubmit={(value) => {
            const trimmed = value.trim();
            const parsed = trimmed.length > 0 ? Number(trimmed) : undefined;
            setPrompt(null);
            void runAction({
              kind: 'retry',
              workId: prompt.workId,
              afterMs: parsed && parsed > 0 ? parsed : undefined,
            });
          }}
          onCancel={() => {
            setPrompt(null);
            setActionFeedback('retry cancelled');
          }}
        />
      )}
      {prompt?.kind === 'filter' && (
        <PromptInput
          label="filter:"
          mode="text"
          onSubmit={(value) => {
            setFilter(value);
            setPrompt(null);
          }}
          onCancel={() => {
            setFilter('');
            setPrompt(null);
          }}
        />
      )}
      {showHelp && <HelpOverlay />}
      {actionFeedback && !pending && (
        <Box>
          <Text dimColor>{actionFeedback}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>
          ↑↓ nav · → attach · u/r/c actions · i input · / filter · ? help · q quit
        </Text>
      </Box>
    </Box>
  );
}

interface DetailProps {
  item: WorkItemDetail | null;
  artifacts: Artifact[];
  sessionName: string;
  windowByName: Map<string, TmuxWindow>;
}

function Detail({ item, artifacts, sessionName, windowByName }: DetailProps): React.ReactElement {
  if (!item) {
    return <Text dimColor>no work items in the queue</Text>;
  }
  const liveName = (() => {
    const exact = `work-${item.id}`;
    const prefix = `work-${item.id}:`;
    if (windowByName.has(exact)) return exact;
    for (const name of windowByName.keys()) if (name.startsWith(prefix)) return name;
    return null;
  })();
  return (
    <Box flexDirection="column">
      <Text bold>
        #{item.id} {item.title}
      </Text>
      <Text dimColor>
        type={item.type} app={item.app_name ?? '—'} team={item.team_name ?? '—'}
      </Text>
      <Text>
        status: <Text color={colorForStatus(item.status)}>{item.status}</Text>
        {item.claimed_by ? <Text dimColor> by {item.claimed_by}</Text> : null}
      </Text>
      {item.branch && <Text dimColor>branch: {item.branch}</Text>}
      <Text dimColor>tmux: {liveName ? `${sessionName}:${liveName}` : '— (not running)'}</Text>
      <Text dimColor>attempts: {item.attempt_count}</Text>
      {item.prompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>prompt</Text>
          <Text>{truncate(item.prompt, 400)}</Text>
        </Box>
      )}
      {artifacts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>artifacts ({artifacts.length})</Text>
          {artifacts.slice(-5).map((a) => (
            <Text key={a.id} dimColor>
              #{a.id} [{a.kind}] {truncate(a.title, 60)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function groupByStatus(work: WorkItemDetail[]): Map<string, WorkItemDetail[]> {
  const map = new Map<string, WorkItemDetail[]>();
  for (const status of STATUS_ORDER) map.set(status, []);
  for (const item of work) {
    const bucket = map.get(item.status) ?? [];
    bucket.push(item);
    map.set(item.status, bucket);
  }
  return map;
}

function flattenForCursor(grouped: Map<string, WorkItemDetail[]>): number[] {
  const out: number[] = [];
  for (const status of STATUS_ORDER) {
    for (const item of grouped.get(status) ?? []) out.push(item.id);
  }
  return out;
}

function moveCursor(
  order: number[],
  current: number | null,
  delta: number,
  set: (id: number) => void,
): void {
  if (order.length === 0) return;
  const idx = current === null ? 0 : order.indexOf(current);
  if (idx === -1) {
    set(order[0]);
    return;
  }
  const next = Math.max(0, Math.min(order.length - 1, idx + delta));
  set(order[next]);
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'claimed':
      return 'cyan';
    case 'pending':
      return 'yellow';
    case 'awaiting_input':
      return 'magenta';
    case 'blocked':
      return 'red';
    case 'failed':
      return 'red';
    case 'complete':
      return 'green';
    case 'cancelled':
      return 'gray';
    default:
      return 'white';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}
