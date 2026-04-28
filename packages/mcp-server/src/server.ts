import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from './db.js';
import { registerAllTools } from './tools/register.js';

export interface CreateAppDeps {
  db: Db;
  token?: string; // optional bearer token; if set, required on /mcp
}

export interface CreateAppResult {
  app: Express;
  mcp: McpServer;
}

export function createApp({ db, token }: CreateAppDeps): CreateAppResult {
  const mcp = new McpServer({ name: 'sapling', version: '0.1.0' });
  registerAllTools(mcp, db);

  const app = express();
  app.use(express.json());
  app.use(
    cors({
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      origin: '*',
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Optional bearer auth — applied only to /mcp.
  app.use('/mcp', (req, res, next) => {
    if (!token) return next();
    const header = req.header('authorization') ?? '';
    const expected = `Bearer ${token}`;
    if (header !== expected) {
      return res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
    }
    next();
  });

  // Stateful Streamable HTTP transport: one transport per session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res
      .status(400)
      .json({
        error: { code: 'invalid_request', message: 'missing session for non-initialize request' },
      });
  });

  return { app, mcp };
}
