import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('projects — DoD verifier inherits team_defaults', () => {
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
    // TRUNCATE apps cascades through services, projects, work_items — and
    // because team_defaults references teams which (via its app_id FK) is in
    // the cascade graph, the entire teams + team_defaults tables get
    // truncated too. We re-apply the seed migration to restore the global
    // sapling-code-review team and the global review/plan defaults, which is
    // the system under test.
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
    await db.pool.query(`DELETE FROM _migrations WHERE filename = '013_seed_ce_teams.sql'`);
    await runMigrations(db.pool);

    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  async function seedProjectWithOnePendingCode(): Promise<{
    appId: number;
    projectId: number;
    workId: number;
  }> {
    const app = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('iris') RETURNING id`,
    );
    const appId = app.rows[0].id;
    const project = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, status)
       VALUES ($1, 'p', 'd', 'DoD', 'in_progress') RETURNING id`,
      [appId],
    );
    const projectId = project.rows[0].id;
    const work = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown, project_id, status)
       VALUES ('code', 'do thing', 'do thing', $1, 'pending') RETURNING id`,
      [projectId],
    );
    return { appId, projectId, workId: work.rows[0].id };
  }

  async function completeWorkViaTools(id: number): Promise<void> {
    await client.call('claim_next_work', { claimed_by: 'tester' });
    await client.call('complete_work', { id, summary_markdown: 'done' });
  }

  it('auto-enqueued DoD verifier inherits the global review team_default (sapling-code-review)', async () => {
    const { projectId, workId } = await seedProjectWithOnePendingCode();
    await completeWorkViaTools(workId);

    const verifier = await db.pool.query<{ team_name: string | null }>(
      `SELECT t.name AS team_name
         FROM work_items w
         LEFT JOIN teams t ON t.id = w.team_id
        WHERE w.project_id = $1 AND w.is_dod_verifier = true
        ORDER BY w.id DESC LIMIT 1`,
      [projectId],
    );
    expect(verifier.rowCount).toBe(1);
    expect(verifier.rows[0].team_name).toBe('sapling-code-review');
  });

  it('per-app default beats the global default on the DoD verifier', async () => {
    const { appId, projectId, workId } = await seedProjectWithOnePendingCode();

    const customTeam = await db.pool.query<{ id: number }>(
      `INSERT INTO teams(name, app_id, lead_prompt_md) VALUES ('iris-reviewers', $1, 'iris lead') RETURNING id`,
      [appId],
    );
    await db.pool.query(
      `INSERT INTO team_defaults(app_id, work_type, team_id) VALUES ($1, 'review', $2)`,
      [appId, customTeam.rows[0].id],
    );

    await completeWorkViaTools(workId);

    const verifier = await db.pool.query<{ team_id: number | null }>(
      `SELECT team_id FROM work_items
        WHERE project_id = $1 AND is_dod_verifier = true
        ORDER BY id DESC LIMIT 1`,
      [projectId],
    );
    expect(verifier.rows[0].team_id).toBe(customTeam.rows[0].id);
  });

  it('clears to NULL when both per-app and global review defaults are absent', async () => {
    await db.pool.query(`DELETE FROM team_defaults WHERE work_type = 'review'`);
    const { projectId, workId } = await seedProjectWithOnePendingCode();
    await completeWorkViaTools(workId);

    const verifier = await db.pool.query<{ team_id: number | null }>(
      `SELECT team_id FROM work_items
        WHERE project_id = $1 AND is_dod_verifier = true
        ORDER BY id DESC LIMIT 1`,
      [projectId],
    );
    expect(verifier.rows[0].team_id).toBeNull();
  });

  it('per-plan auto-enqueued review also inherits the team_default', async () => {
    const app = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('iris') RETURNING id`,
    );
    const project = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(app_id, title, description_md, definition_of_done_md, status)
       VALUES ($1, 'p', 'd', 'DoD', 'in_progress') RETURNING id`,
      [app.rows[0].id],
    );
    const plan = await db.pool.query<{ id: number }>(
      `INSERT INTO plans(title, body_markdown, status) VALUES ('p', 'b', 'active') RETURNING id`,
    );
    const code = await db.pool.query<{ id: number }>(
      `INSERT INTO work_items(type, title, description_markdown, project_id, plan_id, status)
       VALUES ('code', 'c', 'c', $1, $2, 'pending') RETURNING id`,
      [project.rows[0].id, plan.rows[0].id],
    );
    await completeWorkViaTools(code.rows[0].id);

    const review = await db.pool.query<{ team_name: string | null }>(
      `SELECT t.name AS team_name
         FROM work_items w
         LEFT JOIN teams t ON t.id = w.team_id
        WHERE w.project_id = $1 AND w.plan_id = $2 AND w.type = 'review'
        ORDER BY w.id DESC LIMIT 1`,
      [project.rows[0].id, plan.rows[0].id],
    );
    expect(review.rows[0]?.team_name).toBe('sapling-code-review');
  });
});
