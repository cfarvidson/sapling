import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('migration 013 — seed CE-backed teams + defaults', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });

  afterAll(async () => {
    await db.stop();
  });

  it('seeds sapling-code-review and sapling-plan-stress-test as global teams', async () => {
    const { rows } = await db.pool.query<{ name: string; app_id: number | null }>(
      `SELECT name, app_id FROM teams
        WHERE name IN ('sapling-code-review', 'sapling-plan-stress-test')
        ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'sapling-code-review', app_id: null },
      { name: 'sapling-plan-stress-test', app_id: null },
    ]);
  });

  it('attaches the always-on review specialists to sapling-code-review', async () => {
    const { rows } = await db.pool.query<{ subagent_type: string }>(
      `SELECT subagent_type FROM team_roles
         WHERE team_id = (SELECT id FROM teams WHERE name = 'sapling-code-review' AND app_id IS NULL)
         ORDER BY ordinal`,
    );
    const subagents = rows.map((r) => r.subagent_type);
    expect(subagents).toContain('ce-correctness-reviewer');
    expect(subagents).toContain('ce-maintainability-reviewer');
    expect(subagents).toContain('ce-testing-reviewer');
    expect(subagents).toContain('ce-project-standards-reviewer');
    expect(subagents).toContain('ce-security-reviewer');
    expect(subagents).toContain('ce-data-migrations-reviewer');
  });

  it('attaches the plan stress-test specialists to sapling-plan-stress-test', async () => {
    const { rows } = await db.pool.query<{ subagent_type: string }>(
      `SELECT subagent_type FROM team_roles
         WHERE team_id = (SELECT id FROM teams WHERE name = 'sapling-plan-stress-test' AND app_id IS NULL)
         ORDER BY ordinal`,
    );
    const subagents = rows.map((r) => r.subagent_type);
    expect(subagents).toEqual([
      'ce-feasibility-reviewer',
      'ce-scope-guardian-reviewer',
      'ce-coherence-reviewer',
      'ce-security-lens-reviewer',
      'ce-design-lens-reviewer',
      'ce-product-lens-reviewer',
      'ce-adversarial-document-reviewer',
    ]);
  });

  it('seeds the global review and plan team_defaults pointing at the right teams', async () => {
    const { rows } = await db.pool.query<{ work_type: string; team_name: string }>(
      `SELECT td.work_type, t.name AS team_name
         FROM team_defaults td
         JOIN teams t ON t.id = td.team_id
        WHERE td.app_id IS NULL
        ORDER BY td.work_type`,
    );
    expect(rows).toEqual([
      { work_type: 'plan', team_name: 'sapling-plan-stress-test' },
      { work_type: 'review', team_name: 'sapling-code-review' },
    ]);
  });

  it('is idempotent: re-running the migration produces no new rows and no errors', async () => {
    const before = await db.pool.query<{ teams: number; roles: number; defaults: number }>(
      `SELECT
         (SELECT count(*)::int FROM teams WHERE name LIKE 'sapling-%') AS teams,
         (SELECT count(*)::int FROM team_roles) AS roles,
         (SELECT count(*)::int FROM team_defaults WHERE app_id IS NULL) AS defaults`,
    );

    // Force the seed file to re-run by clearing the migration ledger entry,
    // then re-running runMigrations. ON CONFLICT DO NOTHING is what protects
    // us — not the _migrations ledger.
    await db.pool.query(`DELETE FROM _migrations WHERE filename = '013_seed_ce_teams.sql'`);
    await runMigrations(db.pool);

    const after = await db.pool.query<{ teams: number; roles: number; defaults: number }>(
      `SELECT
         (SELECT count(*)::int FROM teams WHERE name LIKE 'sapling-%') AS teams,
         (SELECT count(*)::int FROM team_roles) AS roles,
         (SELECT count(*)::int FROM team_defaults WHERE app_id IS NULL) AS defaults`,
    );

    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('preserves a user-edited team with the same name (no overwrite)', async () => {
    // Simulate a user who edited the lead prompt after the seed ran.
    await db.pool.query(
      `UPDATE teams SET lead_prompt_md = 'CUSTOM USER PROMPT' WHERE name = 'sapling-code-review' AND app_id IS NULL`,
    );
    await db.pool.query(`DELETE FROM _migrations WHERE filename = '013_seed_ce_teams.sql'`);
    await runMigrations(db.pool);

    const { rows } = await db.pool.query<{ lead_prompt_md: string }>(
      `SELECT lead_prompt_md FROM teams WHERE name = 'sapling-code-review' AND app_id IS NULL`,
    );
    expect(rows[0].lead_prompt_md).toBe('CUSTOM USER PROMPT');
  });
});
