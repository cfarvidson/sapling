import { describe, expect, it, vi } from 'vitest';
import { isSessionLostError, wrapMcpClient, type McpClient } from '../src/index.js';

describe('isSessionLostError', () => {
  it('matches the exact MCP server message', () => {
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":"invalid_request","message":"missing session for non-initialize request"}}',
    );
    expect(isSessionLostError(err)).toBe(true);
  });

  it('is case-insensitive on the marker', () => {
    expect(isSessionLostError(new Error('Missing Session For Non-Initialize Request'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isSessionLostError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isSessionLostError(new Error('tool foo failed: bar'))).toBe(false);
    expect(isSessionLostError('not even an error')).toBe(false);
  });
});

describe('wrapMcpClient', () => {
  it('callJson parses JSON content from a successful tool result', async () => {
    const fakeClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ id: 1, status: 'pending' }) }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof wrapMcpClient>[0];
    const wrapped: McpClient = wrapMcpClient(fakeClient);
    const cfg = await wrapped.getRunnerConfig();
    expect(cfg).toEqual({ id: 1, status: 'pending' });
  });

  it('callJson throws when the tool result is marked isError', async () => {
    const fakeClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: '{"error":{"code":"not_found"}}' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof wrapMcpClient>[0];
    const wrapped: McpClient = wrapMcpClient(fakeClient);
    await expect(wrapped.getRunnerConfig()).rejects.toThrow(/tool get_runner_config failed/);
  });
});
