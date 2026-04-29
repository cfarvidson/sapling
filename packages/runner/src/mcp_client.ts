import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RunnerConfig {
  agent_command: string;
  max_concurrent: number;
  poll_interval_ms: number;
  claim_ttl_ms: number;
  max_claim_attempts: number;
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
    close: () => client.close(),
  };
}

export async function createHttpMcpClient(url: string, token?: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'sapling-runner', version: '0.0.0' });
  await client.connect(transport);
  return wrapMcpClient(client);
}
