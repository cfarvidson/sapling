import type { PoolClient } from 'pg';
import type { DiscoveredRepo } from '../github.js';

export interface UpsertResult {
  service_ids: number[];
  created_count: number;
}

export async function upsertServicesFromGitHub(
  client: PoolClient,
  args: { app_id: number; schedule_id: number; repos: DiscoveredRepo[] },
): Promise<UpsertResult> {
  const service_ids: number[] = [];
  let created_count = 0;
  for (const repo of args.repos) {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM services WHERE app_id = $1 AND repo_url = $2`,
      [args.app_id, repo.clone_url],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      service_ids.push(existing.rows[0].id);
      continue;
    }
    const ins = await client.query<{ id: number }>(
      `INSERT INTO services(app_id, name, repo_url, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        args.app_id,
        repo.name,
        repo.clone_url,
        `auto-created by schedule ${args.schedule_id}`,
      ],
    );
    service_ids.push(ins.rows[0].id);
    created_count++;
  }
  return { service_ids, created_count };
}
