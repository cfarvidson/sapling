import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { createProjectInTx } from '../../src/tools/projects.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('createProjectInTx (extracted helper)', () => {
  let db: TestDb;
  let appId: number;
  let svc1: number;
  let svc2: number;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(`TRUNCATE apps RESTART IDENTITY CASCADE`);
    const a = await db.pool.query<{ id: number }>(
      `INSERT INTO apps(name) VALUES ('helper-app') RETURNING id`,
    );
    appId = a.rows[0].id;
    const s1 = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc-1') RETURNING id`,
      [appId],
    );
    svc1 = s1.rows[0].id;
    const s2 = await db.pool.query<{ id: number }>(
      `INSERT INTO services(app_id, name) VALUES ($1, 'svc-2') RETURNING id`,
      [appId],
    );
    svc2 = s2.rows[0].id;
  });

  it('creates a project with service fan-out in a caller-supplied transaction', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createProjectInTx(client, {
        app_id: appId,
        app_name: 'helper-app',
        title: 'Weekly review',
        description_md: 'review the repos',
        definition_of_done_md: 'reviews posted to each repo',
        service_ids: [svc1, svc2],
      });
      await client.query('COMMIT');
      expect(result.project.status).toBe('in_progress');
      expect(result.plan_work_items).toHaveLength(2);
    } finally {
      client.release();
    }
  });

  it('returns a scoping work item when no service_ids supplied', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createProjectInTx(client, {
        app_id: appId,
        app_name: 'helper-app',
        title: 'Unscoped',
        description_md: 'figure it out',
        definition_of_done_md: 'done is done',
      });
      await client.query('COMMIT');
      expect(result.project.status).toBe('scoping');
      expect(result.scoping_work).toBeTruthy();
    } finally {
      client.release();
    }
  });
});
