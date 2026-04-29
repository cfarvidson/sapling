import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

interface WorkRow {
  id: number;
  status: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  next_retry_at: string | null;
}

interface ArtifactRow {
  id: number;
  kind: string;
  title: string;
  body_markdown: string;
  work_item_id: number | null;
}

interface HumanInputResponse {
  work_item_id: number;
  status: string;
  artifact: ArtifactRow;
}

describe('request_human_input / provide_human_input', () => {
  let db: TestDb;
  let client: TestClient;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await client?.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE work_items, artifacts, plans, services, apps RESTART IDENTITY CASCADE',
    );
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  async function enqueue(): Promise<{ id: number }> {
    return (await client.call('enqueue_work', {
      type: 'plan',
      title: 'ambiguous task',
      description_markdown: 'needs clarification',
    })) as { id: number };
  }

  async function fetchRow(id: number): Promise<WorkRow> {
    const { rows } = await db.pool.query<WorkRow>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    return rows[0];
  }

  async function listArtifacts(workItemId: number): Promise<ArtifactRow[]> {
    const { rows } = await db.pool.query<ArtifactRow>(
      `SELECT id, kind, title, body_markdown, work_item_id
         FROM artifacts WHERE work_item_id = $1 ORDER BY id ASC`,
      [workItemId],
    );
    return rows;
  }

  describe('request_human_input', () => {
    it('flips a claimed item to awaiting_input and writes a pending_questions artifact atomically', async () => {
      const item = await enqueue();
      await client.call('claim_next_work', { claimed_by: 'agent-a' });

      const result = (await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Does X include Y?\n2. What about Z?',
      })) as HumanInputResponse;

      expect(result.work_item_id).toBe(item.id);
      expect(result.status).toBe('awaiting_input');
      expect(result.artifact.kind).toBe('pending_questions');
      expect(result.artifact.body_markdown).toContain('Does X include Y?');

      const row = await fetchRow(item.id);
      expect(row.status).toBe('awaiting_input');
      expect(row.claimed_at).toBeNull();
      expect(row.claimed_by).toBeNull();
      expect(row.claim_expires_at).toBeNull();

      const arts = await listArtifacts(item.id);
      expect(arts).toHaveLength(1);
      expect(arts[0].kind).toBe('pending_questions');
    });

    it('flips a pending item to awaiting_input', async () => {
      const item = await enqueue();
      const result = (await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      })) as HumanInputResponse;
      expect(result.status).toBe('awaiting_input');
      expect((await fetchRow(item.id)).status).toBe('awaiting_input');
    });

    it('rejects completed items with conflict 409', async () => {
      const item = await enqueue();
      await client.call('claim_next_work', { claimed_by: 'agent-a' });
      await client.call('complete_work', { id: item.id });

      const raw = await client.callRaw('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });
      expect(raw.isError).toBe(true);
      const payload = JSON.parse(raw.content[0].text) as { error: { code: string } };
      expect(payload.error.code).toBe('conflict');
      expect((await fetchRow(item.id)).status).toBe('completed');
      expect(await listArtifacts(item.id)).toHaveLength(0);
    });

    it('rejects cancelled items with conflict 409', async () => {
      const item = await enqueue();
      await client.call('cancel_work', { id: item.id, reason: 'no longer relevant' });

      const raw = await client.callRaw('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });
      expect(raw.isError).toBe(true);
      const payload = JSON.parse(raw.content[0].text) as { error: { code: string } };
      expect(payload.error.code).toBe('conflict');
    });

    it('returns not_found for unknown id', async () => {
      const raw = await client.callRaw('request_human_input', {
        work_id: 9999,
        questions_markdown: '1. Q?',
      });
      expect(raw.isError).toBe(true);
      const payload = JSON.parse(raw.content[0].text) as { error: { code: string } };
      expect(payload.error.code).toBe('not_found');
    });

    it('claim_next_work skips awaiting_input items', async () => {
      const item = await enqueue();
      await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });
      const claimed = (await client.call('claim_next_work', {
        claimed_by: 'agent-b',
      })) as WorkRow | null;
      expect(claimed).toBeNull();
    });
  });

  describe('provide_human_input', () => {
    it('flips an awaiting_input item to pending and writes an answers artifact atomically', async () => {
      const item = await enqueue();
      await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });

      const result = (await client.call('provide_human_input', {
        work_id: item.id,
        answers_markdown: '1. Yes, definitely.',
      })) as HumanInputResponse;

      expect(result.status).toBe('pending');
      expect(result.artifact.kind).toBe('answers');
      expect(result.artifact.body_markdown).toContain('Yes, definitely.');

      const row = await fetchRow(item.id);
      expect(row.status).toBe('pending');
      expect(row.next_retry_at).toBeNull();

      const arts = await listArtifacts(item.id);
      expect(arts.map((a) => a.kind)).toEqual(['pending_questions', 'answers']);
    });

    it('clears next_retry_at when flipping back to pending', async () => {
      const item = await enqueue();
      await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });
      // Simulate a stale next_retry_at left over from an earlier retry_work call.
      await db.pool.query(
        `UPDATE work_items SET next_retry_at = now() + interval '1 hour' WHERE id = $1`,
        [item.id],
      );

      await client.call('provide_human_input', {
        work_id: item.id,
        answers_markdown: '1. Yes.',
      });
      expect((await fetchRow(item.id)).next_retry_at).toBeNull();
    });

    it('rejects items not in awaiting_input with conflict 409', async () => {
      const item = await enqueue();
      // Still pending, never paused.
      const raw = await client.callRaw('provide_human_input', {
        work_id: item.id,
        answers_markdown: '1. Yes.',
      });
      expect(raw.isError).toBe(true);
      const payload = JSON.parse(raw.content[0].text) as { error: { code: string } };
      expect(payload.error.code).toBe('conflict');
      expect(await listArtifacts(item.id)).toHaveLength(0);
    });

    it('returns not_found for unknown id', async () => {
      const raw = await client.callRaw('provide_human_input', {
        work_id: 9999,
        answers_markdown: '1. Yes.',
      });
      expect(raw.isError).toBe(true);
      const payload = JSON.parse(raw.content[0].text) as { error: { code: string } };
      expect(payload.error.code).toBe('not_found');
    });

    it('runner can re-claim the answered item on the next tick', async () => {
      const item = await enqueue();
      await client.call('claim_next_work', { claimed_by: 'agent-a' });
      await client.call('request_human_input', {
        work_id: item.id,
        questions_markdown: '1. Q?',
      });
      await client.call('provide_human_input', {
        work_id: item.id,
        answers_markdown: '1. Yes.',
      });

      const reclaimed = (await client.call('claim_next_work', {
        claimed_by: 'agent-b',
      })) as WorkRow;
      expect(reclaimed.id).toBe(item.id);
      expect(reclaimed.status).toBe('claimed');
      expect(reclaimed.claimed_by).toBe('agent-b');
    });
  });
});
