import type {
  Artifact,
  AwaitingInputItem,
  McpClient,
  Plan,
  Project,
  ReapedRow,
  RunnerConfig,
  Schedule,
  WorkItem,
  WorkItemDetail,
  WorkItemFilters,
} from 'sapling-mcp-client';

/**
 * Recorded call from a fake-mcp test. Includes the method name and any
 * arguments, so tests assert "method was called with these args" by reading
 * `fakeMcp.calls`.
 */
export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeMcp extends McpClient {
  calls: FakeCall[];
  setWork: (items: WorkItemDetail[]) => void;
  setArtifacts: (items: Artifact[]) => void;
  setPlans: (items: Plan[]) => void;
  setProjects: (items: Project[]) => void;
  setSchedules: (items: Schedule[]) => void;
}

export interface FakeMcpOptions {
  work?: WorkItemDetail[];
  artifacts?: Artifact[];
  plans?: Plan[];
  projects?: Project[];
  schedules?: Schedule[];
  runnerConfig?: RunnerConfig;
}

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  agent_command: 'claude /sapling:work',
  max_concurrent: 2,
  poll_interval_ms: 30000,
  claim_ttl_ms: 7200000,
  max_claim_attempts: 5,
  ntfy_url: null,
  awaiting_input_nag_age_ms: 3600000,
  awaiting_input_nag_repeat_ms: 21600000,
  use_tmux: true,
  tmux_session_name: 'sapling',
};

/**
 * In-memory McpClient implementation for component tests. The TUI is the
 * only caller; the runner has its own integration tests via testcontainers.
 *
 * Each method records a `FakeCall` on `calls`. Tests inspect that array to
 * verify the right MCP method was invoked with the right arguments. Mutators
 * (`unblockWork`, `retryWork`, `cancelWork`, `provideHumanInput`) do not
 * mutate the internal store — tests that need state transitions call
 * `setWork(...)` between renders to simulate the polling loop seeing a new
 * snapshot.
 */
export function makeFakeMcp(opts: FakeMcpOptions = {}): FakeMcp {
  let work: WorkItemDetail[] = opts.work ?? [];
  let artifacts: Artifact[] = opts.artifacts ?? [];
  let plans: Plan[] = opts.plans ?? [];
  let projects: Project[] = opts.projects ?? [];
  let schedules: Schedule[] = opts.schedules ?? [];
  const runnerConfig = opts.runnerConfig ?? DEFAULT_RUNNER_CONFIG;
  const calls: FakeCall[] = [];

  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  return {
    calls,
    setWork(items) {
      work = items;
    },
    setArtifacts(items) {
      artifacts = items;
    },
    setPlans(items) {
      plans = items;
    },
    setProjects(items) {
      projects = items;
    },
    setSchedules(items) {
      schedules = items;
    },
    async reapStuckClaims(now?: string): Promise<ReapedRow[]> {
      record('reapStuckClaims', now);
      return [];
    },
    async getRunnerConfig(): Promise<RunnerConfig> {
      record('getRunnerConfig');
      return runnerConfig;
    },
    async listPendingWork(): Promise<WorkItem[]> {
      record('listPendingWork');
      return work.filter((w) => w.status === 'pending');
    },
    async listAwaitingInput(): Promise<AwaitingInputItem[]> {
      record('listAwaitingInput');
      return work
        .filter((w) => w.status === 'awaiting_input')
        .map((w) => ({ id: w.id, title: w.title, updated_at: w.updated_at }));
    },
    async listWork(filters?: WorkItemFilters): Promise<WorkItemDetail[]> {
      record('listWork', filters);
      return work.slice();
    },
    async listArtifacts(params = {}): Promise<Artifact[]> {
      record('listArtifacts', params);
      const filtered = artifacts.filter((a) => {
        if (params.work_item_id !== undefined && a.work_item_id !== params.work_item_id)
          return false;
        if (params.plan_id !== undefined && a.plan_id !== params.plan_id) return false;
        if (params.service_id !== undefined && a.service_id !== params.service_id) return false;
        if (params.kind !== undefined && a.kind !== params.kind) return false;
        return true;
      });
      return filtered;
    },
    async unblockWork(id: number): Promise<WorkItemDetail> {
      record('unblockWork', id);
      const w = work.find((x) => x.id === id);
      if (!w) throw new Error(`work ${id} not found`);
      return w;
    },
    async retryWork(id: number, afterMs?: number): Promise<WorkItemDetail> {
      record('retryWork', id, afterMs);
      const w = work.find((x) => x.id === id);
      if (!w) throw new Error(`work ${id} not found`);
      return w;
    },
    async cancelWork(id: number, reason?: string): Promise<WorkItemDetail> {
      record('cancelWork', id, reason);
      const w = work.find((x) => x.id === id);
      if (!w) throw new Error(`work ${id} not found`);
      return w;
    },
    async provideHumanInput(workId: number, answersMarkdown: string): Promise<WorkItemDetail> {
      record('provideHumanInput', workId, answersMarkdown);
      const w = work.find((x) => x.id === workId);
      if (!w) throw new Error(`work ${workId} not found`);
      return w;
    },
    async listPlans(filters): Promise<Plan[]> {
      record('listPlans', filters);
      return plans.slice();
    },
    async listProjects(filters): Promise<Project[]> {
      record('listProjects', filters);
      return projects.slice();
    },
    async listSchedules(filters): Promise<Schedule[]> {
      record('listSchedules', filters);
      return schedules.slice();
    },
    async close(): Promise<void> {
      record('close');
    },
  };
}

/**
 * Convenience builder for test fixtures — keeps tests terse without
 * hand-rolling every WorkItemDetail field.
 */
export function makeWorkItem(overrides: Partial<WorkItemDetail> & { id: number }): WorkItemDetail {
  return {
    id: overrides.id,
    type: 'code',
    status: 'pending',
    title: `work ${overrides.id}`,
    service_id: null,
    plan_id: null,
    branch: null,
    app_id: null,
    app_name: null,
    team_id: null,
    team_name: null,
    claimed_by: null,
    prompt: null,
    attempt_count: 0,
    claim_expires_at: null,
    next_retry_at: null,
    depends_on_work_id: null,
    priority: 0,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
    ...overrides,
  };
}
