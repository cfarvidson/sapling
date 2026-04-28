import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import pino from 'pino';
import { createApp } from '../../src/server.js';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('bearer auth on /mcp', () => {
  let db: TestDb;
  let server: Server;
  let baseUrl: string;
  const TOKEN = 'secret-token';

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
    const { app } = createApp({ db: db.pool, token: TOKEN, log: pino({ level: 'silent' }) });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('listen failed');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.stop();
  });

  it('returns 401 when token is missing', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('does not require token on /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("returns non-401 with valid token (we don't care about MCP semantics here)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).not.toBe(401);
  });
});
