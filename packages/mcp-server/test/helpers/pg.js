import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
export async function startTestDb() {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
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
//# sourceMappingURL=pg.js.map
