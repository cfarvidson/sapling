import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RunnerConfig {
  agent_command: string;
  max_concurrent: number;
  poll_interval_ms: number;
  claim_ttl_ms: number;
  max_claim_attempts: number;
  ntfy_url: string | null;
  awaiting_input_nag_age_ms: number;
  awaiting_input_nag_repeat_ms: number;
  use_tmux: boolean;
  tmux_session_name: string;
}

export interface AwaitingInputItem {
  id: number;
  title: string;
  updated_at: string;
}

export interface WorkItem {
  id: number;
  type: 'plan' | 'code' | 'review';
  status: string;
  title: string;
  service_id: number | null;
  plan_id: number | null;
  branch: string | null;
}

/**
 * Richer projection of `work_items` joined with `services`, `apps`, and
 * `teams`. Matches the shape returned by the `list_work` MCP tool — fields
 * not directly used by the runner are kept optional so the existing client
 * surface stays backward-compatible.
 */
export interface WorkItemDetail extends WorkItem {
  app_id: number | null;
  app_name: string | null;
  team_id: number | null;
  team_name: string | null;
  claimed_by: string | null;
  prompt: string | null;
  attempt_count: number;
  claim_expires_at: string | null;
  next_retry_at: string | null;
  depends_on_work_id: number | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemFilters {
  status?: string;
  type?: 'plan' | 'code' | 'review';
  service_id?: number;
  plan_id?: number;
  app_id?: number;
  app_name?: string;
  depends_on_work_id?: number;
}

export interface Artifact {
  id: number;
  kind: string;
  title: string;
  work_item_id: number | null;
  plan_id: number | null;
  service_id: number | null;
  created_at: string;
}

export interface Plan {
  id: number;
  title: string;
  status: string;
  service_id: number | null;
  parent_plan_id: number | null;
  project_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlanFilters {
  service_id?: number;
  project_id?: number;
  status?: string;
}

export interface Project {
  id: number;
  title: string;
  status: string;
  app_id: number;
  app_name: string;
  linear_url: string | null;
  dod_cycle_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectFilters {
  app_name?: string;
  status?: string;
}

export interface Schedule {
  id: number;
  name: string;
  source_type: 'app' | 'github_org';
  app_id: number;
  github_org: string | null;
  cron_expr: string;
  timezone: string;
  overlap_policy: string;
  title_template: string;
  description_md: string;
  definition_of_done_md: string;
  enabled: boolean;
  last_fired_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduleFilters {
  app_name?: string;
  source_type?: 'app' | 'github_org';
  enabled?: boolean;
}

export interface ReapedRow {
  id: number;
  status: 'pending' | 'failed';
  attempt_count: number;
  prior_claimed_by: string | null;
}

export interface McpClient {
  reapStuckClaims: (now?: string) => Promise<ReapedRow[]>;
  getRunnerConfig: () => Promise<RunnerConfig>;
  listPendingWork: () => Promise<WorkItem[]>;
  listAwaitingInput: () => Promise<AwaitingInputItem[]>;
  listWork: (filters?: WorkItemFilters) => Promise<WorkItemDetail[]>;
  listArtifacts: (params?: {
    work_item_id?: number;
    plan_id?: number;
    service_id?: number;
    kind?: string;
  }) => Promise<Artifact[]>;
  unblockWork: (id: number) => Promise<WorkItemDetail>;
  retryWork: (id: number, afterMs?: number) => Promise<WorkItemDetail>;
  cancelWork: (id: number, reason?: string) => Promise<WorkItemDetail>;
  provideHumanInput: (workId: number, answersMarkdown: string) => Promise<WorkItemDetail>;
  listPlans: (filters?: PlanFilters) => Promise<Plan[]>;
  listProjects: (filters?: ProjectFilters) => Promise<Project[]>;
  listSchedules: (filters?: ScheduleFilters) => Promise<Schedule[]>;
  close: () => Promise<void>;
}

interface RawToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

export function wrapMcpClient(client: Client): McpClient {
  async function callJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = (await client.callTool({ name, arguments: args })) as RawToolResult;
    const text = res.content[0]?.text ?? 'null';
    if (res.isError) throw new Error(`tool ${name} failed: ${text}`);
    return JSON.parse(text) as T;
  }
  return {
    reapStuckClaims: (now) => callJson<ReapedRow[]>('reap_stuck_claims', now ? { now } : {}),
    getRunnerConfig: () => callJson<RunnerConfig>('get_runner_config'),
    listPendingWork: () => callJson<WorkItem[]>('list_work', { status: 'pending' }),
    listAwaitingInput: () =>
      callJson<AwaitingInputItem[]>('list_work', { status: 'awaiting_input' }),
    listWork: (filters = {}) =>
      callJson<WorkItemDetail[]>('list_work', { ...filters } as Record<string, unknown>),
    listArtifacts: (params = {}) =>
      callJson<Artifact[]>('list_artifacts', { ...params } as Record<string, unknown>),
    unblockWork: (id) => callJson<WorkItemDetail>('unblock_work', { id }),
    retryWork: (id, afterMs) =>
      callJson<WorkItemDetail>(
        'retry_work',
        afterMs === undefined ? { id } : { id, after_ms: afterMs },
      ),
    cancelWork: (id, reason) =>
      callJson<WorkItemDetail>('cancel_work', reason === undefined ? { id } : { id, reason }),
    provideHumanInput: (workId, answersMarkdown) =>
      callJson<WorkItemDetail>('provide_human_input', {
        work_id: workId,
        answers_markdown: answersMarkdown,
      }),
    listPlans: (filters = {}) =>
      callJson<Plan[]>('list_plans', { ...filters } as Record<string, unknown>),
    listProjects: (filters = {}) =>
      callJson<Project[]>('list_projects', { ...filters } as Record<string, unknown>),
    listSchedules: (filters = {}) =>
      callJson<Schedule[]>('list_schedules', { ...filters } as Record<string, unknown>),
    close: () => client.close(),
  };
}

export async function createHttpMcpClient(url: string, token?: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'sapling-mcp-client', version: '0.0.0' });
  await client.connect(transport);
  return wrapMcpClient(client);
}
