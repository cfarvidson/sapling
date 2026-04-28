import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb } from '../helpers/pg.js';
describe('migrate', () => {
  let db;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.stop();
  });
  it('applies the initial migration and creates the expected tables', async () => {
    await runMigrations(db.pool);
    const { rows } = await db.pool.query(`SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`);
    const tables = rows.map((r) => r.table_name);
    expect(tables).toEqual(['_migrations', 'apps', 'artifacts', 'plans', 'services', 'work_items']);
  });
  it('is idempotent — running twice does not fail or duplicate', async () => {
    // First call already ran above. Run again.
    await runMigrations(db.pool);
    const { rows } = await db.pool.query(`SELECT count(*)::text as count FROM _migrations`);
    expect(rows[0].count).toBe('1');
  });
});
//# sourceMappingURL=migrate.test.js.map
