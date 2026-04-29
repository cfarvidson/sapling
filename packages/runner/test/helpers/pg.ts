import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

export interface TestDb {
  pool: pg.Pool;
  url: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sapling_test')
    .withUsername('sapling')
    .withPassword('test')
    .start();

  const url = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: url });

  return {
    pool,
    url,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
