import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface RawToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

export interface TestClient {
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  callRaw: (name: string, args?: Record<string, unknown>) => Promise<RawToolResult>;
  close: () => Promise<void>;
}

export async function connectInMemory(server: McpServer): Promise<TestClient> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    callRaw: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args ?? {} })) as RawToolResult;
      return result;
    },
    call: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args ?? {} })) as RawToolResult;
      const text = result.content[0]?.text ?? '';
      const parsed = text ? JSON.parse(text) : null;
      if (result.isError) throw new Error(`tool ${name} returned error: ${text}`);
      return parsed;
    },
    close: async () => {
      await client.close();
    },
  };
}
