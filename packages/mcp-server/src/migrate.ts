import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { withTx } from './db.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schema');

export async function runMigrations(pool: Db, schemaDir: string = SCHEMA_DIR): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const all = (await readdir(schemaDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string }>(`SELECT filename FROM _migrations`);
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of all) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(schemaDir, file), 'utf8');
    await withTx(pool, async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO _migrations(filename) VALUES ($1)`, [file]);
    });
  }
}
