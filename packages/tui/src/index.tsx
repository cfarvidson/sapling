#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { createHttpMcpClient } from 'sapling-mcp-client';
import { App } from './App.js';

async function main(): Promise<void> {
  const url = process.env.SAPLING_MCP_URL ?? 'http://127.0.0.1:3333/mcp';
  const token = process.env.MCP_TOKEN;
  const sessionName = process.env.SAPLING_TMUX_SESSION ?? 'sapling';

  const mcp = await createHttpMcpClient(url, token);
  const { waitUntilExit } = render(<App mcp={mcp} sessionName={sessionName} />, {
    exitOnCtrlC: true,
  });
  await waitUntilExit();
  await mcp.close();
}

main().catch((err) => {
  console.error('sapling-tui fatal:', err);
  process.exit(1);
});
