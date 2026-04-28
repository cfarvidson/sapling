# Sapling MCP Dev Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Sapling MCP server (TypeScript + Postgres in docker-compose) and the companion Claude Code plugin that ships `/sapling:work`, `/sapling:plan`, `/sapling:enqueue`, `/sapling:status`, and `/sapling:context` slash commands.

**Architecture:** A thin Node.js MCP server exposes 20 tools over Streamable HTTP, talking to Postgres directly via the `pg` driver. A separate Claude Code plugin under `packages/claude-plugin/` wraps the most common tool flows as slash commands. Two docker-compose services (`postgres`, `mcp-server`); single Node process; migrations applied on startup. The current Claude session pulls work via `claim_next_work` and executes it locally — Sapling stores knowledge and tracks the queue but does not run agents.

**Tech Stack:**

- Node.js 22 LTS + TypeScript 5.x
- pnpm workspaces (monorepo: `packages/mcp-server`, `packages/claude-plugin`)
- `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express` (MCP SDK; Streamable HTTP transport)
- `pg` (Postgres driver), Postgres 16 (docker image)
- `zod` v4 (input validation)
- `pino` (structured logging)
- `vitest` (test runner) + `testcontainers` (real Postgres in tests)
- `express` + `cors` (HTTP layer for the MCP transport)

**Spec deviation flagged here:** The spec's example `.mcp.json` uses `"type": "sse"` and `url: ".../sse"`. The current MCP TypeScript SDK has superseded the legacy SSE transport with Streamable HTTP. We will use `"type": "http"` and `url: "http://localhost:3333/mcp"` instead. Conceptually identical to the spec's intent (HTTP-served MCP in docker); only the wire protocol detail differs.

---

## File Structure

```
sapling/
├── docker-compose.yml             # postgres + mcp-server
├── Makefile                       # up / down / logs / psql / test / nuke
├── README.md
├── .env.example                   # POSTGRES_PASSWORD, MCP_TOKEN (optional), etc.
├── .gitignore                     # node_modules, dist, data/
├── pnpm-workspace.yaml
├── package.json                   # root: workspace scripts, prettier/eslint
├── .prettierrc.json
├── .eslintrc.cjs
├── data/                          # gitignored: postgres volume
├── docs/superpowers/
│   ├── specs/2026-04-28-sapling-mcp-dev-workbench-design.md
│   └── plans/2026-04-28-sapling-mcp-dev-workbench.md   # this file
├── packages/
│   ├── mcp-server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── index.ts           # bootstrap: migrate, build server, listen
│   │   │   ├── config.ts          # env parsing
│   │   │   ├── logger.ts          # pino setup
│   │   │   ├── db.ts              # pg pool + tx helper
│   │   │   ├── migrate.ts         # startup migrator
│   │   │   ├── errors.ts          # error codes + mapping helpers
│   │   │   ├── server.ts          # express app + MCP transport wiring + /health + auth
│   │   │   ├── tools/
│   │   │   │   ├── register.ts    # central registerAllTools(server, db)
│   │   │   │   ├── products.ts    # apps + services tools
│   │   │   │   ├── plans.ts
│   │   │   │   ├── work.ts
│   │   │   │   └── artifacts.ts
│   │   │   └── schema/
│   │   │       └── 001_init.sql   # initial schema (verbatim from spec)
│   │   └── test/
│   │       ├── helpers/
│   │       │   ├── pg.ts          # testcontainers postgres + reset helpers
│   │       │   └── mcp-client.ts  # in-process MCP client for integration tests
│   │       ├── integration/
│   │       │   ├── migrate.test.ts
│   │       │   ├── health.test.ts
│   │       │   ├── products.test.ts
│   │       │   ├── plans.test.ts
│   │       │   ├── work.test.ts
│   │       │   ├── work-claim-concurrency.test.ts
│   │       │   ├── artifacts.test.ts
│   │       │   └── auth.test.ts
│   │       └── unit/
│   │           └── errors.test.ts
│   └── claude-plugin/
│       └── .claude/
│           ├── .mcp.json          # template MCP config (sapling -> http)
│           └── skills/
│               ├── sapling-work/SKILL.md
│               ├── sapling-plan/SKILL.md
│               ├── sapling-enqueue/SKILL.md
│               ├── sapling-status/SKILL.md
│               └── sapling-context/SKILL.md
```

**Responsibility map (one file = one job):**

- `config.ts` — read env, validate, export typed config object.
- `db.ts` — single `pg.Pool`, `withTx<T>(fn)` helper.
- `migrate.ts` — apply `*.sql` files in order against `_migrations` ledger.
- `errors.ts` — `AppError` class + codes + a `toToolResult()` mapper.
- `server.ts` — build the Express app, wire Streamable HTTP transport, wrap tools with timing/logging, `/health`, optional bearer auth.
- `tools/<family>.ts` — declare zod schemas + handlers; export a `register(server, db)` function.
- `tools/register.ts` — call each family's `register()`.

---

## Conventions for every task

- **Branching:** none — work directly on `main` for v1 (greenfield repo, single user).
- **Before each commit:** run `pnpm prettier --write .` and `pnpm lint --fix`. Both are wired in Task 1.
- **Test runner:** `pnpm --filter mcp-server test`. Runs unit, then integration (skips integration if Docker unavailable — see Task 3).
- **Commit messages:** Conventional Commits (e.g. `feat(server): add /health endpoint`).

---

## Phase 0: Project Skeleton (Tasks 1–3)

### Task 1: Initialize monorepo root

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.prettierrc.json`
- Create: `.eslintrc.cjs`
- Create: `README.md` (placeholder; full content in Task 22)

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "sapling",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "lint": "eslint --ext .ts packages",
    "format": "prettier --write .",
    "test": "pnpm --filter mcp-server test",
    "build": "pnpm --filter mcp-server build"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0"
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
data/
*.log
.DS_Store
.env
coverage/
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Postgres
POSTGRES_USER=sapling
POSTGRES_PASSWORD=changeme-locally
POSTGRES_DB=sapling
POSTGRES_PORT=5432

# Sapling MCP server
DATABASE_URL=postgres://sapling:changeme-locally@postgres:5432/sapling
SAPLING_PORT=3333
LOG_LEVEL=info
LOG_PAYLOADS=false
# Optional bearer token. Leave unset to disable auth.
# MCP_TOKEN=
```

- [ ] **Step 5: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 6: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
  env: { node: true, es2023: true },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
```

- [ ] **Step 7: Create placeholder `README.md`**

```markdown
# Sapling

AI-native MCP dev workbench. See `docs/superpowers/specs/2026-04-28-sapling-mcp-dev-workbench-design.md`.

Full README in Task 22.
```

- [ ] **Step 8: Install root deps**

Run: `pnpm install`
Expected: No errors; `pnpm-lock.yaml` created.

- [ ] **Step 9: Format + commit**

```bash
pnpm format
git add .
git commit -m "chore: initialize pnpm workspace, lint/format, env example"
```

---

### Task 2: docker-compose with Postgres only (no mcp-server yet)

**Files:**

- Create: `docker-compose.yml`

We bring Postgres up first so the next task's tests can use a local container if `testcontainers` is unavailable.

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-sapling}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-changeme-locally}
      POSTGRES_DB: ${POSTGRES_DB:-sapling}
    ports:
      - '127.0.0.1:${POSTGRES_PORT:-5432}:5432'
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-sapling}']
      interval: 2s
      timeout: 5s
      retries: 10

  # mcp-server added in Task 18 once the image builds.
```

- [ ] **Step 2: Bring it up to verify**

Run: `cp .env.example .env && docker compose up -d postgres`
Expected: `postgres` container becomes healthy within ~5s. Verify with `docker compose ps`.

- [ ] **Step 3: Tear down (we'll bring it back in tests)**

Run: `docker compose down`
Expected: Container removed; `./data/postgres` directory persists (and is gitignored).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add postgres service to docker-compose"
```

---

### Task 3: Initialize `packages/mcp-server` package

**Files:**

- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/vitest.config.ts`
- Create: `packages/mcp-server/src/index.ts` (stub)

- [ ] **Step 1: Create `packages/mcp-server/package.json`**

```json
{
  "name": "mcp-server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^1.0.0",
    "@modelcontextprotocol/node": "^1.0.0",
    "@modelcontextprotocol/express": "^1.0.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "pg": "^8.13.0",
    "pino": "^9.5.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "testcontainers": "^10.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/mcp-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `packages/mcp-server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000, // testcontainers can be slow on first pull
    pool: 'forks', // each file gets its own pg pool / container
  },
});
```

- [ ] **Step 4: Create stub `packages/mcp-server/src/index.ts`**

```ts
// Bootstrap fills in across Tasks 5–8 (migrate -> server.start -> listen).
console.log('sapling mcp-server stub');
```

- [ ] **Step 5: Install package deps**

Run: `pnpm install`
Expected: All packages installed; lockfile updated.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `pnpm --filter mcp-server build`
Expected: `dist/index.js` exists, no errors.

- [ ] **Step 7: Verify Vitest runs (no tests yet — should report 0 files)**

Run: `pnpm --filter mcp-server test`
Expected: `No test files found` — exit code 0 (vitest treats this as success).

- [ ] **Step 8: Format + commit**

```bash
pnpm format
git add packages/mcp-server pnpm-lock.yaml
git commit -m "feat(mcp-server): scaffold typescript package with vitest and tsc"
```

---

## Phase 1: Database + Migrations (Tasks 4–6)

### Task 4: Write `001_init.sql` (verbatim schema from spec)

**Files:**

- Create: `packages/mcp-server/src/schema/001_init.sql`

- [ ] **Step 1: Create the SQL file**

```sql
-- Sapling initial schema

-- Apps & services
CREATE TABLE apps (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id           SERIAL PRIMARY KEY,
  app_id       INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  repo_url     TEXT,
  description  TEXT,
  tech_stack   TEXT[] NOT NULL DEFAULT '{}',
  depends_on   TEXT[] NOT NULL DEFAULT '{}',
  conventions  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

-- Plans
CREATE TYPE plan_status AS ENUM ('draft','active','completed','archived');

CREATE TABLE plans (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  status          plan_status NOT NULL DEFAULT 'draft',
  service_id      INT REFERENCES services(id) ON DELETE SET NULL,
  parent_plan_id  INT REFERENCES plans(id)    ON DELETE SET NULL,
  body_markdown   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plans_service_idx ON plans(service_id);
CREATE INDEX plans_status_idx  ON plans(status);

-- Work queue
CREATE TYPE work_type   AS ENUM ('plan','code','review');
CREATE TYPE work_status AS ENUM ('pending','claimed','completed','failed','cancelled');

CREATE TABLE work_items (
  id                   SERIAL PRIMARY KEY,
  type                 work_type   NOT NULL,
  status               work_status NOT NULL DEFAULT 'pending',
  title                TEXT NOT NULL,
  description_markdown TEXT NOT NULL,
  priority             INT  NOT NULL DEFAULT 0,
  service_id           INT  REFERENCES services(id) ON DELETE SET NULL,
  plan_id              INT  REFERENCES plans(id)    ON DELETE SET NULL,
  branch               TEXT,
  pr_url               TEXT,
  claimed_at           TIMESTAMPTZ,
  claimed_by           TEXT,
  completed_at         TIMESTAMPTZ,
  failure_reason       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_pending_idx ON work_items(priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX work_status_idx  ON work_items(status);

-- Artifacts
CREATE TABLE artifacts (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  work_item_id  INT REFERENCES work_items(id) ON DELETE SET NULL,
  plan_id       INT REFERENCES plans(id)      ON DELETE SET NULL,
  service_id    INT REFERENCES services(id)   ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_work_idx ON artifacts(work_item_id);
CREATE INDEX artifacts_plan_idx ON artifacts(plan_id);
```

- [ ] **Step 2: Verify SQL is syntactically valid by applying to a throwaway DB**

Run:

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U sapling -d sapling \
  -v ON_ERROR_STOP=1 -f - < packages/mcp-server/src/schema/001_init.sql
docker compose exec postgres psql -U sapling -d sapling -c "\dt"
```

Expected: lists 4 tables (`apps`, `artifacts`, `plans`, `services`, `work_items`). No errors.

Reset for next task:

```bash
docker compose down -v
rm -rf data/postgres
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/schema/001_init.sql
git commit -m "feat(schema): add initial schema (apps, services, plans, work_items, artifacts)"
```

---

### Task 5: TDD `migrate.ts` (apply once, idempotent on second run)

**Files:**

- Create: `packages/mcp-server/test/helpers/pg.ts`
- Create: `packages/mcp-server/test/integration/migrate.test.ts`
- Create: `packages/mcp-server/src/db.ts`
- Create: `packages/mcp-server/src/migrate.ts`

- [ ] **Step 1: Create test helper for ephemeral Postgres**

`packages/mcp-server/test/helpers/pg.ts`:

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
```

Note: this requires the `@testcontainers/postgresql` extension. Add to `packages/mcp-server/package.json` `devDependencies`:

```json
"@testcontainers/postgresql": "^10.13.0"
```

Then run: `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/mcp-server/test/integration/migrate.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('migrate', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it('applies the initial migration and creates the expected tables', async () => {
    await runMigrations(db.pool);
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toEqual(['_migrations', 'apps', 'artifacts', 'plans', 'services', 'work_items']);
  });

  it('is idempotent — running twice does not fail or duplicate', async () => {
    // First call already ran above. Run again.
    await runMigrations(db.pool);
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM _migrations`,
    );
    expect(rows[0].count).toBe('1');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test test/integration/migrate.test.ts`
Expected: FAIL — `Cannot find module '../../src/migrate.js'` or similar.

- [ ] **Step 4: Implement `db.ts`**

`packages/mcp-server/src/db.ts`:

```ts
import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString });
}

export async function withTx<T>(pool: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 5: Implement `migrate.ts`**

`packages/mcp-server/src/migrate.ts`:

```ts
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/migrate.test.ts`
Expected: PASS — both `it` blocks green.

- [ ] **Step 7: Format + commit**

```bash
pnpm format
git add packages/mcp-server pnpm-lock.yaml
git commit -m "feat(mcp-server): add startup migrator and pg pool helper"
```

---

### Task 6: `config.ts` (env parsing) and `logger.ts`

**Files:**

- Create: `packages/mcp-server/src/config.ts`
- Create: `packages/mcp-server/src/logger.ts`

These are tiny — no dedicated test files, but they must compile cleanly.

- [ ] **Step 1: Implement `config.ts`**

`packages/mcp-server/src/config.ts`:

```ts
import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  SAPLING_PORT: z.coerce.number().int().positive().default(3333),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PAYLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MCP_TOKEN: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 2: Implement `logger.ts`**

`packages/mcp-server/src/logger.ts`:

```ts
import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'sapling' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter mcp-server build`
Expected: No errors.

- [ ] **Step 4: Format + commit**

```bash
pnpm format
git add packages/mcp-server/src
git commit -m "feat(mcp-server): add config loader and pino logger factory"
```

---

## Phase 2: Errors + HTTP Server + Health (Tasks 7–8)

### Task 7: `errors.ts` (error codes + tool-result mapping)

**Files:**

- Create: `packages/mcp-server/src/errors.ts`
- Create: `packages/mcp-server/test/unit/errors.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/mcp-server/test/unit/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AppError, errorToToolResult, mapPgError } from '../../src/errors.js';

describe('errors', () => {
  it('serializes AppError into a structured tool result with isError', () => {
    const err = new AppError('not_found', 'service id 42 not found');
    const result = errorToToolResult(err);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ error: { code: 'not_found', message: 'service id 42 not found' } }),
    });
  });

  it('maps Postgres unique violation (23505) to conflict', () => {
    const err = mapPgError({ code: '23505', message: 'duplicate key', detail: 'Key (...) exists' });
    expect(err.code).toBe('conflict');
  });

  it('maps Postgres foreign key violation (23503) to not_found', () => {
    const err = mapPgError({ code: '23503', message: 'fk violation', detail: 'Key not present' });
    expect(err.code).toBe('not_found');
  });

  it('maps unknown errors to internal', () => {
    const err = mapPgError({ code: '99999', message: 'who knows' });
    expect(err.code).toBe('internal');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter mcp-server test test/unit/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `errors.ts`**

`packages/mcp-server/src/errors.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/server';

export type ErrorCode = 'invalid_input' | 'not_found' | 'conflict' | 'claim_race' | 'internal';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
}

export function mapPgError(err: PgErrorLike): AppError {
  switch (err.code) {
    case '23505': // unique_violation
      return new AppError('conflict', err.message ?? 'unique constraint violated');
    case '23503': // foreign_key_violation
      return new AppError('not_found', err.message ?? 'referenced row not found');
    default:
      return new AppError('internal', err.message ?? 'internal error');
  }
}

export function errorToToolResult(err: AppError): CallToolResult {
  const payload = { error: { code: err.code, message: err.message, issues: err.issues } };
  // Strip undefined for clean output
  if (payload.error.issues === undefined) delete (payload.error as Record<string, unknown>).issues;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/unit/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(mcp-server): add AppError, pg error mapping, tool-result serializer"
```

---

### Task 8: HTTP server + MCP transport + `/health` (TDD)

**Files:**

- Create: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/test/integration/health.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/mcp-server/test/integration/health.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/server.js';
import { runMigrations } from '../../src/migrate.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('GET /health', () => {
  let db: TestDb;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    db = await startTestDb();
    await runMigrations(db.pool);
    const { app } = createApp({ db: db.pool, token: undefined });
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

  it('returns ok with db up when the pool is healthy', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, db: 'up' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mcp-server test test/integration/health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server.ts`**

`packages/mcp-server/src/server.ts`:

```ts
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import type { Db } from './db.js';
import { registerAllTools } from './tools/register.js';

export interface CreateAppDeps {
  db: Db;
  token?: string; // optional bearer token; if set, required on /mcp
}

export interface CreateAppResult {
  app: Express;
  mcp: McpServer;
}

export function createApp({ db, token }: CreateAppDeps): CreateAppResult {
  const mcp = new McpServer({ name: 'sapling', version: '0.1.0' });
  registerAllTools(mcp, db);

  const app = createMcpExpressApp();
  app.use(
    cors({
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      origin: '*',
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Optional bearer auth — applied only to /mcp.
  app.use('/mcp', (req, res, next) => {
    if (!token) return next();
    const header = req.header('authorization') ?? '';
    const expected = `Bearer ${token}`;
    if (header !== expected) {
      return res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
    }
    next();
  });

  // Stateful Streamable HTTP transport: one transport per session id.
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      error: { code: 'invalid_request', message: 'missing session for non-initialize request' },
    });
  });

  return { app, mcp };
}
```

- [ ] **Step 4: Stub `tools/register.ts` so `server.ts` imports cleanly**

Create `packages/mcp-server/src/tools/register.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';

export function registerAllTools(_server: McpServer, _db: Db): void {
  // Tool families registered in Tasks 9–15.
}
```

- [ ] **Step 5: Wire `index.ts` bootstrap**

`packages/mcp-server/src/index.ts`:

```ts
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const pool = createPool(config.DATABASE_URL);
  log.info('running migrations');
  await runMigrations(pool);

  const { app } = createApp({ db: pool, token: config.MCP_TOKEN });
  app.listen(config.SAPLING_PORT, () => {
    log.info({ port: config.SAPLING_PORT }, 'sapling mcp-server listening');
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Run health test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/health.test.ts`
Expected: PASS.

- [ ] **Step 7: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(mcp-server): wire express + streamable HTTP transport, /health endpoint"
```

---

## Phase 3: Products Tools (Tasks 9–10)

### Task 9: `register_app` and `list_apps` (TDD)

**Files:**

- Create: `packages/mcp-server/test/helpers/mcp-client.ts`
- Create: `packages/mcp-server/test/integration/products.test.ts`
- Create: `packages/mcp-server/src/tools/products.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`

- [ ] **Step 1: Create an in-process MCP client helper**

The integration tests will create an MCP server in memory and call tools through the SDK without going through HTTP. This keeps tests fast and focused on tool behavior.

`packages/mcp-server/test/helpers/mcp-client.ts`:

```ts
import { Client } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

export interface TestClient {
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  callRaw: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
  close: () => Promise<void>;
}

export async function connectInMemory(server: McpServer): Promise<TestClient> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    callRaw: async (name, args) => {
      const result = await client.callTool({ name, arguments: args ?? {} });
      return result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    },
    call: async (name, args) => {
      const result = await client.callTool({ name, arguments: args ?? {} });
      const r = result as { isError?: boolean; content: Array<{ type: string; text: string }> };
      const text = r.content[0]?.text ?? '';
      const parsed = text ? JSON.parse(text) : null;
      if (r.isError) throw new Error(`tool ${name} returned error: ${text}`);
      return parsed;
    },
    close: async () => {
      await client.close();
    },
  };
}
```

> **SDK import note:** `Client` and `InMemoryTransport` may live in a separate package (commonly `@modelcontextprotocol/client`) depending on installed SDK version. To verify, run `pnpm --filter mcp-server why @modelcontextprotocol/server` and inspect the package's exports. If `InMemoryTransport`/`Client` are not in `@modelcontextprotocol/server`, install `@modelcontextprotocol/client` (same major version as the server package) and import from there. If neither package exports them, fall back to the HTTP pattern used in `health.test.ts`: stand up an Express listener with `createApp({...})`, point a `fetch`-based client at it, and call tools via JSON-RPC over `POST /mcp`.

- [ ] **Step 2: Write the failing test**

`packages/mcp-server/test/integration/products.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('apps tools', () => {
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
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('register_app creates an app and returns it', async () => {
    const app = await client.call('register_app', { name: 'checkout', description: 'cart + pay' });
    expect(app).toMatchObject({ id: 1, name: 'checkout', description: 'cart + pay' });
  });

  it('list_apps returns all apps in insertion order', async () => {
    await client.call('register_app', { name: 'a' });
    await client.call('register_app', { name: 'b' });
    const apps = await client.call('list_apps', {});
    expect(apps).toMatchObject([{ name: 'a' }, { name: 'b' }]);
  });

  it('register_app rejects duplicate names with conflict error', async () => {
    await client.call('register_app', { name: 'dup' });
    const raw = await client.callRaw('register_app', { name: 'dup' });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('conflict');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter mcp-server test test/integration/products.test.ts`
Expected: FAIL — `Tool register_app not found` or similar.

- [ ] **Step 4: Implement `tools/products.ts` (apps portion only for now)**

`packages/mcp-server/src/tools/products.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerProducts(server: McpServer, db: Db): void {
  server.registerTool(
    'register_app',
    {
      description: 'Create an app (top-level product grouping for services).',
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      }),
    },
    async ({ name, description }) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO apps(name, description) VALUES ($1, $2) RETURNING *`,
          [name, description ?? null],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'list_apps',
    {
      description: 'List all apps.',
      inputSchema: z.object({}),
    },
    async () => {
      const { rows } = await db.query(`SELECT * FROM apps ORDER BY id ASC`);
      return ok(rows);
    },
  );

  // Service tools added in Task 10.
}
```

- [ ] **Step 5: Wire into `register.ts`**

`packages/mcp-server/src/tools/register.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { registerProducts } from './products.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/products.test.ts`
Expected: PASS.

- [ ] **Step 7: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): register_app and list_apps with conflict mapping"
```

---

### Task 10: Service tools (`register_service`, `list_services`, `get_service`, `update_service`)

**Files:**

- Modify: `packages/mcp-server/src/tools/products.ts`
- Modify: `packages/mcp-server/test/integration/products.test.ts`

- [ ] **Step 1: Add failing tests for services to the same file**

Append to `products.test.ts`:

```ts
describe('services tools', () => {
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
    await db.pool.query('TRUNCATE apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
    await client.call('register_app', { name: 'checkout' });
  });

  it('register_service attaches a service under an app', async () => {
    const svc = await client.call('register_service', {
      app_name: 'checkout',
      name: 'checkout-api',
      repo_url: 'https://github.com/x/checkout-api',
      tech_stack: ['typescript', 'postgres'],
      depends_on: ['auth'],
      conventions: 'see CLAUDE.md in repo',
    });
    expect(svc).toMatchObject({
      name: 'checkout-api',
      tech_stack: ['typescript', 'postgres'],
      depends_on: ['auth'],
    });
  });

  it('list_services returns services optionally filtered by app', async () => {
    await client.call('register_service', { app_name: 'checkout', name: 'api' });
    await client.call('register_service', { app_name: 'checkout', name: 'web' });
    await client.call('register_app', { name: 'orders' });
    await client.call('register_service', { app_name: 'orders', name: 'api' });
    const all = (await client.call('list_services', {})) as unknown[];
    expect(all).toHaveLength(3);
    const checkout = (await client.call('list_services', { app_name: 'checkout' })) as unknown[];
    expect(checkout).toHaveLength(2);
  });

  it('get_service accepts id or {app, name}', async () => {
    const created = (await client.call('register_service', {
      app_name: 'checkout',
      name: 'api',
    })) as { id: number };
    const byId = await client.call('get_service', { id: created.id });
    expect(byId).toMatchObject({ name: 'api' });
    const byName = await client.call('get_service', { app_name: 'checkout', name: 'api' });
    expect(byName).toMatchObject({ id: created.id });
  });

  it('get_service returns not_found error for unknown id', async () => {
    const raw = await client.callRaw('get_service', { id: 9999 });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });

  it('update_service patches provided fields and leaves others alone', async () => {
    const created = (await client.call('register_service', {
      app_name: 'checkout',
      name: 'api',
      tech_stack: ['typescript'],
    })) as { id: number };
    const updated = await client.call('update_service', {
      id: created.id,
      description: 'now with desc',
      tech_stack: ['typescript', 'pg'],
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'api', // unchanged
      description: 'now with desc',
      tech_stack: ['typescript', 'pg'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `pnpm --filter mcp-server test test/integration/products.test.ts`
Expected: FAIL on each new `it`.

- [ ] **Step 3: Implement service tools in `products.ts`**

Append to `packages/mcp-server/src/tools/products.ts`:

```ts
const ServiceLookup = z
  .object({
    id: z.number().int().positive().optional(),
    app_name: z.string().optional(),
    name: z.string().optional(),
  })
  .refine((v) => v.id !== undefined || (v.app_name !== undefined && v.name !== undefined), {
    message: 'must provide id, or both app_name and name',
  });

export function registerServiceTools(server: McpServer, db: Db): void {
  server.registerTool(
    'register_service',
    {
      description: 'Create a service under an app.',
      inputSchema: z.object({
        app_name: z.string().min(1),
        name: z.string().min(1),
        repo_url: z.string().url().optional(),
        description: z.string().optional(),
        tech_stack: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        conventions: z.string().optional(),
      }),
    },
    async (input) => {
      try {
        const app = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          input.app_name,
        ]);
        if (app.rowCount === 0) {
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        }
        const { rows } = await db.query(
          `INSERT INTO services(app_id, name, repo_url, description, tech_stack, depends_on, conventions)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            app.rows[0].id,
            input.name,
            input.repo_url ?? null,
            input.description ?? null,
            input.tech_stack ?? [],
            input.depends_on ?? [],
            input.conventions ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'list_services',
    {
      description: 'List services, optionally filtered to one app.',
      inputSchema: z.object({ app_name: z.string().optional() }),
    },
    async ({ app_name }) => {
      if (app_name) {
        const { rows } = await db.query(
          `SELECT s.* FROM services s JOIN apps a ON a.id = s.app_id
           WHERE a.name = $1 ORDER BY s.id ASC`,
          [app_name],
        );
        return ok(rows);
      }
      const { rows } = await db.query(`SELECT * FROM services ORDER BY id ASC`);
      return ok(rows);
    },
  );

  server.registerTool(
    'get_service',
    {
      description: 'Fetch a service by id, or by (app_name, name).',
      inputSchema: ServiceLookup,
    },
    async (input) => {
      let row: Record<string, unknown> | undefined;
      if (input.id !== undefined) {
        const { rows } = await db.query(`SELECT * FROM services WHERE id = $1`, [input.id]);
        row = rows[0];
      } else {
        const { rows } = await db.query(
          `SELECT s.* FROM services s JOIN apps a ON a.id = s.app_id
           WHERE a.name = $1 AND s.name = $2`,
          [input.app_name, input.name],
        );
        row = rows[0];
      }
      if (!row) return errorToToolResult(new AppError('not_found', 'service not found'));
      return ok(row);
    },
  );

  server.registerTool(
    'update_service',
    {
      description: 'Patch any subset of service fields by id.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        repo_url: z.string().url().nullable().optional(),
        description: z.string().nullable().optional(),
        tech_stack: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        conventions: z.string().nullable().optional(),
      }),
    },
    async ({ id, ...patch }) => {
      const fields = Object.keys(patch) as Array<keyof typeof patch>;
      if (fields.length === 0) {
        return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const f of fields) {
        sets.push(`${f} = $${i++}`);
        values.push(patch[f]);
      }
      sets.push(`updated_at = now()`);
      values.push(id);
      try {
        const { rows } = await db.query(
          `UPDATE services SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `service ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}
```

- [ ] **Step 4: Wire into `register.ts`**

Update `packages/mcp-server/src/tools/register.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { registerProducts, registerServiceTools } from './products.js';

export function registerAllTools(server: McpServer, db: Db): void {
  registerProducts(server, db);
  registerServiceTools(server, db);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/products.test.ts`
Expected: PASS — all tests in both `describe` blocks green.

- [ ] **Step 6: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): register_service, list_services, get_service, update_service"
```

---

## Phase 4: Plans Tools (Task 11)

### Task 11: `create_plan`, `get_plan`, `list_plans`, `update_plan` (TDD)

**Files:**

- Create: `packages/mcp-server/test/integration/plans.test.ts`
- Create: `packages/mcp-server/src/tools/plans.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`

- [ ] **Step 1: Write failing tests**

`packages/mcp-server/test/integration/plans.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('plans tools', () => {
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
    await db.pool.query('TRUNCATE plans, services, apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('create_plan stores title, body, default status=draft', async () => {
    const plan = await client.call('create_plan', {
      title: 'Add OAuth',
      body_markdown: '# Goal\nAdd OAuth',
    });
    expect(plan).toMatchObject({ id: 1, title: 'Add OAuth', status: 'draft' });
  });

  it('get_plan returns the full body', async () => {
    const created = (await client.call('create_plan', {
      title: 'A',
      body_markdown: 'long body here',
    })) as { id: number };
    const fetched = (await client.call('get_plan', { id: created.id })) as {
      body_markdown: string;
    };
    expect(fetched.body_markdown).toBe('long body here');
  });

  it('list_plans omits body and supports status filter', async () => {
    const a = (await client.call('create_plan', { title: 'a', body_markdown: 'x' })) as {
      id: number;
    };
    await client.call('create_plan', { title: 'b', body_markdown: 'x' });
    await client.call('update_plan', { id: a.id, status: 'completed' });

    const all = (await client.call('list_plans', {})) as Array<{
      id: number;
      body_markdown?: string;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0].body_markdown).toBeUndefined();

    const done = (await client.call('list_plans', { status: 'completed' })) as Array<unknown>;
    expect(done).toHaveLength(1);
  });

  it('update_plan patches title and body', async () => {
    const created = (await client.call('create_plan', { title: 'old', body_markdown: 'old' })) as {
      id: number;
    };
    const updated = await client.call('update_plan', {
      id: created.id,
      title: 'new',
      body_markdown: 'new',
    });
    expect(updated).toMatchObject({ title: 'new', body_markdown: 'new' });
  });

  it('create_plan with non-existent service_id returns not_found', async () => {
    const raw = await client.callRaw('create_plan', {
      title: 'x',
      body_markdown: 'x',
      service_id: 9999,
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `pnpm --filter mcp-server test test/integration/plans.test.ts`
Expected: FAIL — tools missing.

- [ ] **Step 3: Implement `tools/plans.ts`**

`packages/mcp-server/src/tools/plans.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

const PlanStatus = z.enum(['draft', 'active', 'completed', 'archived']);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const PLAN_LIST_COLUMNS = 'id, title, status, service_id, parent_plan_id, created_at, updated_at';

export function registerPlans(server: McpServer, db: Db): void {
  server.registerTool(
    'create_plan',
    {
      description: 'Store a new plan as markdown body plus structured fields.',
      inputSchema: z.object({
        title: z.string().min(1),
        body_markdown: z.string(),
        service_id: z.number().int().positive().optional(),
        parent_plan_id: z.number().int().positive().optional(),
        status: PlanStatus.default('draft'),
      }),
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO plans(title, body_markdown, service_id, parent_plan_id, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            input.title,
            input.body_markdown,
            input.service_id ?? null,
            input.parent_plan_id ?? null,
            input.status,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_plan',
    {
      description: 'Fetch a plan including the full body_markdown.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM plans WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `plan ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_plans',
    {
      description:
        'List plans (titles + structured fields, no body) optionally filtered by service or status.',
      inputSchema: z.object({
        service_id: z.number().int().positive().optional(),
        status: PlanStatus.optional(),
      }),
    },
    async ({ service_id, status }) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (service_id !== undefined) {
        vals.push(service_id);
        conds.push(`service_id = $${vals.length}`);
      }
      if (status !== undefined) {
        vals.push(status);
        conds.push(`status = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT ${PLAN_LIST_COLUMNS} FROM plans ${where} ORDER BY id ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  server.registerTool(
    'update_plan',
    {
      description: 'Patch any subset of plan fields.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        body_markdown: z.string().optional(),
        status: PlanStatus.optional(),
        service_id: z.number().int().positive().nullable().optional(),
        parent_plan_id: z.number().int().positive().nullable().optional(),
      }),
    },
    async ({ id, ...patch }) => {
      const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
      if (fields.length === 0) {
        return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const f of fields) {
        sets.push(`${f} = $${i++}`);
        values.push(patch[f as keyof typeof patch]);
      }
      sets.push(`updated_at = now()`);
      values.push(id);
      try {
        const { rows } = await db.query(
          `UPDATE plans SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `plan ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );
}
```

- [ ] **Step 4: Wire into `register.ts`**

```ts
import { registerPlans } from './plans.js';
// inside registerAllTools:
registerPlans(server, db);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/plans.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): create_plan, get_plan, list_plans, update_plan"
```

---

## Phase 5: Work Queue Tools (Tasks 12–14)

### Task 12: `enqueue_work`, `get_work`, `list_work` (TDD)

**Files:**

- Create: `packages/mcp-server/test/integration/work.test.ts`
- Create: `packages/mcp-server/src/tools/work.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`

- [ ] **Step 1: Write failing tests**

`packages/mcp-server/test/integration/work.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('work queue tools (basic CRUD)', () => {
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
    await db.pool.query('TRUNCATE work_items, plans, services, apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('enqueue_work stores a typed pending task', async () => {
    const item = await client.call('enqueue_work', {
      type: 'plan',
      title: 'Plan checkout v2',
      description_markdown: 'Goal: ...',
      priority: 5,
    });
    expect(item).toMatchObject({
      type: 'plan',
      status: 'pending',
      title: 'Plan checkout v2',
      priority: 5,
    });
  });

  it('get_work returns full record', async () => {
    const created = (await client.call('enqueue_work', {
      type: 'code',
      title: 'do thing',
      description_markdown: 'why',
    })) as { id: number };
    const fetched = await client.call('get_work', { id: created.id });
    expect(fetched).toMatchObject({ id: created.id, title: 'do thing', type: 'code' });
  });

  it('list_work supports status, type, service, plan filters', async () => {
    await client.call('enqueue_work', { type: 'plan', title: 'p', description_markdown: 'x' });
    await client.call('enqueue_work', { type: 'code', title: 'c', description_markdown: 'x' });

    const codeOnly = (await client.call('list_work', { type: 'code' })) as Array<unknown>;
    expect(codeOnly).toHaveLength(1);

    const allPending = (await client.call('list_work', { status: 'pending' })) as Array<unknown>;
    expect(allPending).toHaveLength(2);
  });

  it('enqueue_work with bad enum rejects with invalid_input', async () => {
    const raw = await client.callRaw('enqueue_work', {
      type: 'nope',
      title: 'x',
      description_markdown: 'x',
    });
    expect(raw.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `pnpm --filter mcp-server test test/integration/work.test.ts`
Expected: FAIL — tools missing.

- [ ] **Step 3: Implement `tools/work.ts` (CRUD portion only — claim/complete in next tasks)**

`packages/mcp-server/src/tools/work.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

const WorkType = z.enum(['plan', 'code', 'review']);
const WorkStatus = z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled']);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerWork(server: McpServer, db: Db): void {
  server.registerTool(
    'enqueue_work',
    {
      description: 'Add a typed task to the queue (plan / code / review).',
      inputSchema: z.object({
        type: WorkType,
        title: z.string().min(1),
        description_markdown: z.string(),
        priority: z.number().int().default(0),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        branch: z.string().optional(),
        pr_url: z.string().url().optional(),
      }),
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO work_items
             (type, title, description_markdown, priority, service_id, plan_id, branch, pr_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            input.type,
            input.title,
            input.description_markdown,
            input.priority,
            input.service_id ?? null,
            input.plan_id ?? null,
            input.branch ?? null,
            input.pr_url ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_work',
    {
      description: 'Fetch a single work item.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM work_items WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_work',
    {
      description: 'List work items with optional filters.',
      inputSchema: z.object({
        status: WorkStatus.optional(),
        type: WorkType.optional(),
        service_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
      }),
    },
    async (filters) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(filters)) {
        if (v === undefined) continue;
        vals.push(v);
        conds.push(`${k} = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC`,
        vals,
      );
      return ok(rows);
    },
  );

  // claim_next_work / complete_work / fail_work / cancel_work added in Tasks 13–14.
}
```

- [ ] **Step 4: Wire into `register.ts`**

```ts
import { registerWork } from './work.js';
// inside registerAllTools:
registerWork(server, db);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/work.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): enqueue_work, get_work, list_work"
```

---

### Task 13: `claim_next_work` atomic claim with concurrency test

**Files:**

- Create: `packages/mcp-server/test/integration/work-claim-concurrency.test.ts`
- Modify: `packages/mcp-server/src/tools/work.ts`

- [ ] **Step 1: Write the failing concurrency test**

`packages/mcp-server/test/integration/work-claim-concurrency.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('claim_next_work — concurrency', () => {
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
    await db.pool.query('TRUNCATE work_items, plans, services, apps RESTART IDENTITY CASCADE');
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('returns null when queue is empty', async () => {
    const result = await client.call('claim_next_work', { claimed_by: 'a' });
    expect(result).toBeNull();
  });

  it('returns highest-priority then oldest first', async () => {
    await client.call('enqueue_work', {
      type: 'code',
      title: 'old low',
      description_markdown: 'x',
      priority: 0,
    });
    await client.call('enqueue_work', {
      type: 'code',
      title: 'high',
      description_markdown: 'x',
      priority: 5,
    });

    const first = (await client.call('claim_next_work', { claimed_by: 'a' })) as { title: string };
    expect(first.title).toBe('high');
    const second = (await client.call('claim_next_work', { claimed_by: 'a' })) as { title: string };
    expect(second.title).toBe('old low');
  });

  it('two concurrent claims for one item: exactly one wins, other gets null', async () => {
    await client.call('enqueue_work', { type: 'code', title: 'only', description_markdown: 'x' });

    const [a, b] = await Promise.all([
      client.call('claim_next_work', { claimed_by: 'agent-a' }),
      client.call('claim_next_work', { claimed_by: 'agent-b' }),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    const losers = [a, b].filter((x) => x === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('respects type filter', async () => {
    await client.call('enqueue_work', { type: 'plan', title: 'p', description_markdown: 'x' });
    await client.call('enqueue_work', { type: 'code', title: 'c', description_markdown: 'x' });

    const codeOnly = (await client.call('claim_next_work', {
      claimed_by: 'a',
      types: ['code'],
    })) as { title: string };
    expect(codeOnly.title).toBe('c');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter mcp-server test test/integration/work-claim-concurrency.test.ts`
Expected: FAIL — `claim_next_work` not registered.

- [ ] **Step 3: Add `claim_next_work` to `tools/work.ts`**

Append to `packages/mcp-server/src/tools/work.ts`:

```ts
const WorkTypeArr = z.array(WorkType).min(1);

export function registerWorkClaim(server: McpServer, db: Db): void {
  server.registerTool(
    'claim_next_work',
    {
      description: 'Atomically claim the next pending work item. Returns null if none.',
      inputSchema: z.object({
        claimed_by: z.string().min(1),
        types: WorkTypeArr.optional(),
        service_id: z.number().int().positive().optional(),
      }),
    },
    async ({ claimed_by, types, service_id }) => {
      const { rows } = await db.query(
        `WITH next AS (
           SELECT id FROM work_items
            WHERE status = 'pending'
              AND ($1::work_type[] IS NULL OR type = ANY($1))
              AND ($2::int IS NULL OR service_id = $2)
            ORDER BY priority DESC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE work_items w
            SET status = 'claimed', claimed_at = now(), claimed_by = $3, updated_at = now()
           FROM next
          WHERE w.id = next.id
         RETURNING w.*`,
        [types ?? null, service_id ?? null, claimed_by],
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows[0] ?? null) }] };
    },
  );
}
```

- [ ] **Step 4: Wire into `register.ts`**

```ts
import { registerWork, registerWorkClaim } from './work.js';
// inside registerAllTools:
registerWork(server, db);
registerWorkClaim(server, db);
```

- [ ] **Step 5: Run concurrency test to verify it passes**

Run: `pnpm --filter mcp-server test test/integration/work-claim-concurrency.test.ts`
Expected: PASS — all four `it` blocks green.

- [ ] **Step 6: Re-run the full work test file too (no regression)**

Run: `pnpm --filter mcp-server test test/integration/work.test.ts test/integration/work-claim-concurrency.test.ts`
Expected: Both pass.

- [ ] **Step 7: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): claim_next_work with FOR UPDATE SKIP LOCKED + concurrency tests"
```

---

### Task 14: `complete_work`, `fail_work`, `cancel_work`

**Files:**

- Modify: `packages/mcp-server/test/integration/work.test.ts`
- Modify: `packages/mcp-server/src/tools/work.ts`

- [ ] **Step 1: Append failing tests**

Append a new `describe` block to `work.test.ts`:

```ts
describe('complete / fail / cancel work', () => {
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

  async function enqueueAndClaim() {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await client.call('claim_next_work', { claimed_by: 'tester' });
    return item;
  }

  it('complete_work marks completed, sets completed_at', async () => {
    const item = await enqueueAndClaim();
    const completed = (await client.call('complete_work', { id: item.id })) as {
      status: string;
      completed_at: string;
    };
    expect(completed.status).toBe('completed');
    expect(new Date(completed.completed_at).getTime()).toBeGreaterThan(0);
  });

  it('complete_work with summary creates an artifact and links it', async () => {
    const item = await enqueueAndClaim();
    const completed = (await client.call('complete_work', {
      id: item.id,
      summary_markdown: '# done\nstuff',
    })) as { id: number };
    const artifacts = (await client.call('list_artifacts', {
      work_item_id: completed.id,
    })) as Array<unknown>;
    expect(artifacts).toHaveLength(1);
  });

  it('fail_work sets status=failed and stores reason', async () => {
    const item = await enqueueAndClaim();
    const failed = (await client.call('fail_work', { id: item.id, reason: 'tests broke' })) as {
      status: string;
      failure_reason: string;
    };
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toBe('tests broke');
  });

  it('cancel_work sets status=cancelled', async () => {
    const item = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    const cancelled = (await client.call('cancel_work', {
      id: item.id,
      reason: 'no longer needed',
    })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });
});
```

> **Note:** the `complete_work` artifact test depends on `list_artifacts` from Task 15. Run tests in order, or skip this `it` until Task 15 lands. To keep TDD strict here, defer ONLY that one `it` to Task 15 (mark with `it.todo(...)`) and run the rest now.

- [ ] **Step 2: Run to verify failures (excluding the deferred artifact test)**

Run: `pnpm --filter mcp-server test test/integration/work.test.ts`
Expected: FAIL on the new `it` blocks.

- [ ] **Step 3: Implement the three tools in `tools/work.ts`**

Append to `packages/mcp-server/src/tools/work.ts`:

```ts
export function registerWorkLifecycle(server: McpServer, db: Db): void {
  server.registerTool(
    'complete_work',
    {
      description:
        'Mark a work item completed; optionally store a summary as an artifact, or link an existing artifact.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        summary_markdown: z.string().optional(),
        artifact_id: z.number().int().positive().optional(),
      }),
    },
    async ({ id, summary_markdown, artifact_id }) => {
      try {
        return await (async () => {
          const client = await db.connect();
          try {
            await client.query('BEGIN');
            const upd = await client.query(
              `UPDATE work_items
                  SET status = 'completed', completed_at = now(), updated_at = now()
                WHERE id = $1
              RETURNING *`,
              [id],
            );
            if (upd.rowCount === 0) {
              await client.query('ROLLBACK');
              return errorToToolResult(new AppError('not_found', `work ${id} not found`));
            }
            const work = upd.rows[0];
            if (summary_markdown) {
              await client.query(
                `INSERT INTO artifacts(kind, title, body_markdown, work_item_id)
                 VALUES ('summary', $1, $2, $3)`,
                [`Summary: ${work.title}`, summary_markdown, id],
              );
            }
            if (artifact_id) {
              await client.query(`UPDATE artifacts SET work_item_id = $1 WHERE id = $2`, [
                id,
                artifact_id,
              ]);
            }
            await client.query('COMMIT');
            return ok(work);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        })();
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'fail_work',
    {
      description: 'Mark a work item failed with a reason. Failed items are not auto-retried.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        reason: z.string().min(1),
      }),
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE work_items SET status='failed', failure_reason=$2, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, reason],
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'cancel_work',
    {
      description: 'Cancel a work item (soft delete equivalent).',
      inputSchema: z.object({
        id: z.number().int().positive(),
        reason: z.string().optional(),
      }),
    },
    async ({ id, reason }) => {
      const { rows } = await db.query(
        `UPDATE work_items SET status='cancelled', failure_reason=$2, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, reason ?? null],
      );
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `work ${id} not found`));
      return ok(rows[0]);
    },
  );
}
```

- [ ] **Step 4: Wire into `register.ts`**

```ts
import { registerWork, registerWorkClaim, registerWorkLifecycle } from './work.js';
// inside registerAllTools:
registerWork(server, db);
registerWorkClaim(server, db);
registerWorkLifecycle(server, db);
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter mcp-server test test/integration/work.test.ts`
Expected: All non-deferred tests pass; the artifact-linking test is `it.todo`.

- [ ] **Step 6: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): complete_work, fail_work, cancel_work"
```

---

## Phase 6: Artifacts Tools (Task 15)

### Task 15: `attach_artifact`, `get_artifact`, `list_artifacts`

**Files:**

- Create: `packages/mcp-server/test/integration/artifacts.test.ts`
- Create: `packages/mcp-server/src/tools/artifacts.ts`
- Modify: `packages/mcp-server/src/tools/register.ts`
- Modify: `packages/mcp-server/test/integration/work.test.ts` (un-skip the deferred artifact test)

- [ ] **Step 1: Write failing tests**

`packages/mcp-server/test/integration/artifacts.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { runMigrations } from '../../src/migrate.js';
import { registerAllTools } from '../../src/tools/register.js';
import { connectInMemory, type TestClient } from '../helpers/mcp-client.js';
import { startTestDb, type TestDb } from '../helpers/pg.js';

describe('artifacts tools', () => {
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
      'TRUNCATE artifacts, work_items, plans, services, apps RESTART IDENTITY CASCADE',
    );
    await client?.close();
    const server = new McpServer({ name: 'sapling-test', version: '0.0.0' });
    registerAllTools(server, db.pool);
    client = await connectInMemory(server);
  });

  it('attach_artifact stores body and links to work item', async () => {
    const w = (await client.call('enqueue_work', {
      type: 'review',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    const a = (await client.call('attach_artifact', {
      kind: 'review_notes',
      title: 'review',
      body_markdown: '## observations',
      work_item_id: w.id,
    })) as { id: number; work_item_id: number };
    expect(a.work_item_id).toBe(w.id);
  });

  it('get_artifact returns full body', async () => {
    const a = (await client.call('attach_artifact', {
      kind: 'snippet',
      title: 'x',
      body_markdown: 'long content',
    })) as { id: number };
    const fetched = (await client.call('get_artifact', { id: a.id })) as { body_markdown: string };
    expect(fetched.body_markdown).toBe('long content');
  });

  it('list_artifacts omits body and supports filters', async () => {
    const w = (await client.call('enqueue_work', {
      type: 'code',
      title: 't',
      description_markdown: 'x',
    })) as { id: number };
    await client.call('attach_artifact', {
      kind: 'note',
      title: 'a',
      body_markdown: 'x',
      work_item_id: w.id,
    });
    await client.call('attach_artifact', { kind: 'note', title: 'b', body_markdown: 'x' });
    const linked = (await client.call('list_artifacts', { work_item_id: w.id })) as Array<{
      body_markdown?: string;
    }>;
    expect(linked).toHaveLength(1);
    expect(linked[0].body_markdown).toBeUndefined();
  });

  it('attach_artifact with bad work_item_id returns not_found', async () => {
    const raw = await client.callRaw('attach_artifact', {
      kind: 'note',
      title: 'x',
      body_markdown: 'x',
      work_item_id: 9999,
    });
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0].text);
    expect(body.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter mcp-server test test/integration/artifacts.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement `tools/artifacts.ts`**

`packages/mcp-server/src/tools/artifacts.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const ARTIFACT_LIST_COLUMNS = 'id, kind, title, work_item_id, plan_id, service_id, created_at';

export function registerArtifacts(server: McpServer, db: Db): void {
  server.registerTool(
    'attach_artifact',
    {
      description: 'Store a markdown artifact, optionally linked to a work item, plan, or service.',
      inputSchema: z.object({
        kind: z.string().min(1),
        title: z.string().min(1),
        body_markdown: z.string(),
        work_item_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        service_id: z.number().int().positive().optional(),
      }),
    },
    async (input) => {
      try {
        const { rows } = await db.query(
          `INSERT INTO artifacts(kind, title, body_markdown, work_item_id, plan_id, service_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            input.kind,
            input.title,
            input.body_markdown,
            input.work_item_id ?? null,
            input.plan_id ?? null,
            input.service_id ?? null,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description: 'Fetch an artifact including the body.',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => {
      const { rows } = await db.query(`SELECT * FROM artifacts WHERE id = $1`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `artifact ${id} not found`));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      description: 'List artifacts (titles only, no body) with optional filters.',
      inputSchema: z.object({
        work_item_id: z.number().int().positive().optional(),
        plan_id: z.number().int().positive().optional(),
        service_id: z.number().int().positive().optional(),
        kind: z.string().optional(),
      }),
    },
    async (filters) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(filters)) {
        if (v === undefined) continue;
        vals.push(v);
        conds.push(`${k} = $${vals.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT ${ARTIFACT_LIST_COLUMNS} FROM artifacts ${where} ORDER BY id ASC`,
        vals,
      );
      return ok(rows);
    },
  );
}
```

- [ ] **Step 4: Wire into `register.ts`**

```ts
import { registerArtifacts } from './artifacts.js';
// inside registerAllTools:
registerArtifacts(server, db);
```

- [ ] **Step 5: Un-skip the deferred test in `work.test.ts`**

Change the artifact-linking test from `it.todo(...)` to `it(...)` (the implementation from Task 14 already creates the artifact; it just needed `list_artifacts` to verify).

- [ ] **Step 6: Run all tests**

Run: `pnpm --filter mcp-server test`
Expected: All tests pass — products, plans, work, work concurrency, artifacts, health, migrate, errors.

- [ ] **Step 7: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(tools): attach_artifact, get_artifact, list_artifacts"
```

---

## Phase 7: Polish — Logging, Auth, Dockerfile (Tasks 16–18)

### Task 16: Wrap tool handlers with logging middleware

**Files:**

- Modify: `packages/mcp-server/src/server.ts`

The simplest place to add timing is to wrap `registerTool` calls. Since tools are registered across many files, do this with a small wrapper passed into `registerAllTools`. Alternative: monkey-patch on the server. We'll add a wrapper helper.

- [ ] **Step 1: Add a `withInstrumentation` helper that wraps the McpServer's registerTool**

`packages/mcp-server/src/server.ts` — add this above `createApp`:

```ts
import type { Logger } from 'pino';

function instrumentMcpServer(mcp: McpServer, log: Logger): void {
  const originalRegister = mcp.registerTool.bind(mcp);
  mcp.registerTool = ((
    name: string,
    opts: Parameters<typeof originalRegister>[1],
    handler: Parameters<typeof originalRegister>[2],
  ) => {
    const wrapped: typeof handler = async (input, ctx) => {
      const start = Date.now();
      try {
        const result = await handler(input as never, ctx as never);
        const isError = !!(result as { isError?: boolean }).isError;
        log.info({ tool: name, durationMs: Date.now() - start, ok: !isError }, 'tool_call');
        return result;
      } catch (err) {
        log.error({ tool: name, durationMs: Date.now() - start, err }, 'tool_call_threw');
        throw err;
      }
    };
    return originalRegister(name, opts, wrapped);
  }) as typeof originalRegister;
}
```

- [ ] **Step 2: Update `createApp` to accept a logger and call `instrumentMcpServer`**

Modify the signature:

```ts
import type { Logger } from 'pino';

export interface CreateAppDeps {
  db: Db;
  token?: string;
  log: Logger;
}

export function createApp({ db, token, log }: CreateAppDeps): CreateAppResult {
  const mcp = new McpServer({ name: 'sapling', version: '0.1.0' });
  instrumentMcpServer(mcp, log);
  registerAllTools(mcp, db);
  // ...rest unchanged
}
```

- [ ] **Step 3: Update `index.ts` to pass the logger**

```ts
const { app } = createApp({ db: pool, token: config.MCP_TOKEN, log });
```

- [ ] **Step 4: Update tests to pass a logger**

In each integration test where `createApp` is called (currently only `health.test.ts`), add:

```ts
import pino from 'pino';
const log = pino({ level: 'silent' });
const { app } = createApp({ db: db.pool, token: undefined, log });
```

(The in-memory tool tests use `new McpServer(...)` directly and are not affected; they will not have logging instrumentation, which is fine for tests.)

- [ ] **Step 5: Run all tests — should pass unchanged**

Run: `pnpm --filter mcp-server test`
Expected: PASS, no regressions.

- [ ] **Step 6: Format + commit**

```bash
pnpm format
git add packages/mcp-server
git commit -m "feat(server): instrument tool calls with structured pino logs"
```

---

### Task 17: Auth integration test (verifies the `/mcp` bearer guard)

**Files:**

- Create: `packages/mcp-server/test/integration/auth.test.ts`

The auth middleware itself was added in Task 8. This task adds a test that proves it works.

- [ ] **Step 1: Write the test**

`packages/mcp-server/test/integration/auth.test.ts`:

```ts
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), // arbitrary
    });
    expect(res.status).not.toBe(401);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter mcp-server test test/integration/auth.test.ts`
Expected: PASS — the middleware was already added in Task 8.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/test/integration/auth.test.ts
git commit -m "test(server): cover bearer auth guard on /mcp"
```

---

### Task 18: Dockerfile + finalize docker-compose with `mcp-server` service

**Files:**

- Create: `packages/mcp-server/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create `packages/mcp-server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests for cached install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/mcp-server/package.json packages/mcp-server/

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --frozen-lockfile --filter mcp-server...

# Copy sources and build
COPY packages/mcp-server packages/mcp-server
RUN pnpm --filter mcp-server build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/mcp-server/package.json packages/mcp-server/
COPY --from=builder /app/packages/mcp-server/dist packages/mcp-server/dist
COPY --from=builder /app/packages/mcp-server/src/schema packages/mcp-server/src/schema

RUN pnpm install --frozen-lockfile --filter mcp-server... --prod

EXPOSE 3333
CMD ["node", "packages/mcp-server/dist/index.js"]
```

- [ ] **Step 2: Add `mcp-server` to `docker-compose.yml`**

Replace the placeholder comment in `docker-compose.yml`:

```yaml
mcp-server:
  build:
    context: .
    dockerfile: packages/mcp-server/Dockerfile
  restart: unless-stopped
  depends_on:
    postgres:
      condition: service_healthy
  environment:
    DATABASE_URL: postgres://${POSTGRES_USER:-sapling}:${POSTGRES_PASSWORD:-changeme-locally}@postgres:5432/${POSTGRES_DB:-sapling}
    SAPLING_PORT: 3333
    LOG_LEVEL: ${LOG_LEVEL:-info}
    LOG_PAYLOADS: ${LOG_PAYLOADS:-false}
    MCP_TOKEN: ${MCP_TOKEN:-}
  ports:
    - '127.0.0.1:3333:3333'
```

- [ ] **Step 3: Build and run end-to-end**

Run:

```bash
docker compose build mcp-server
docker compose up -d
docker compose logs -f mcp-server
```

Expected: logs show `running migrations` then `sapling mcp-server listening`. `curl http://127.0.0.1:3333/health` returns `{"ok":true,"db":"up"}`.

Tear down:

```bash
docker compose down
```

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/Dockerfile docker-compose.yml
git commit -m "feat(deploy): containerize mcp-server, wire compose with healthcheck dep"
```

---

## Phase 8: Claude Plugin Skills (Tasks 19–21)

### Task 19: Plugin scaffold + `.mcp.json` template

**Files:**

- Create: `packages/claude-plugin/.claude/.mcp.json`
- Create: `packages/claude-plugin/README.md`

- [ ] **Step 1: Create `.mcp.json` template**

`packages/claude-plugin/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "sapling": {
      "type": "http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

- [ ] **Step 2: Plugin README**

`packages/claude-plugin/README.md`:

```markdown
# Sapling — Claude Code Plugin

Slash commands and `.mcp.json` template for the Sapling MCP server.

## Install

1. Start the MCP server: `make up` from the repo root.
2. Copy `.claude/.mcp.json` into your project's `.claude/` directory (or merge into `~/.claude.json`).
3. Copy `.claude/skills/` into your project's `.claude/skills/` directory.

## Commands

- `/sapling:work` — pull next pending task and execute it
- `/sapling:plan <description>` — drop a planning task into the queue
- `/sapling:enqueue <code|review> <description>` — drop a code or review task
- `/sapling:status` — show queue health
- `/sapling:context <service>` — load full context for a service
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin
git commit -m "feat(plugin): scaffold claude-plugin with .mcp.json and README"
```

---

### Task 20: `/sapling:work`, `/sapling:plan`, `/sapling:enqueue` skills

**Files:**

- Create: `packages/claude-plugin/.claude/skills/sapling-work/SKILL.md`
- Create: `packages/claude-plugin/.claude/skills/sapling-plan/SKILL.md`
- Create: `packages/claude-plugin/.claude/skills/sapling-enqueue/SKILL.md`

- [ ] **Step 1: Create `sapling-work/SKILL.md`**

```markdown
---
name: sapling-work
description: Pull the next pending Sapling work item and execute it. Triggers on /sapling:work.
---

# /sapling:work

Claim the next pending work item from Sapling and execute it in this session.

## Steps

1. Call MCP tool `mcp__sapling__claim_next_work` with `claimed_by` set to a stable agent label
   (e.g. `claude-${HOSTNAME}` from the env). Optional: pass `types` if the user specified
   a filter in arguments (e.g. `/sapling:work code` -> `types: ['code']`).
2. If the result is `null`, tell the user: "No pending work in the Sapling queue. Add one with /sapling:plan or /sapling:enqueue." and stop.
3. Otherwise, branch on `type`:

### type = 'plan'

- Read `description_markdown`, `service_id` (if set: `mcp__sapling__get_service`).
- Use the superpowers:brainstorming and superpowers:writing-plans skills as needed.
- Once the plan is drafted, call `mcp__sapling__create_plan` to persist it.
- Optionally call `mcp__sapling__enqueue_work` for follow-on `code` tasks linked via `plan_id`.
- Call `mcp__sapling__complete_work` with `id` and a one-paragraph `summary_markdown`.

### type = 'code'

- If `plan_id` is set, call `mcp__sapling__get_plan(id=plan_id)` and read the body.
- If `service_id` is set, call `mcp__sapling__get_service(id=service_id)` to load conventions, repo URL, tech stack.
- Do the actual work in the relevant repo on disk (filesystem, git). Sapling does not own the code.
- For notable artifacts (review notes, draft snippets), call `mcp__sapling__attach_artifact` with `work_item_id`.
- When done, optionally `mcp__sapling__enqueue_work(type='review', branch=..., pr_url=...)`.
- Call `mcp__sapling__complete_work` with `summary_markdown`.

### type = 'review'

- Read `branch` / `pr_url` from the work item.
- Inspect the diff (filesystem, `gh pr diff`, etc.).
- Call `mcp__sapling__attach_artifact(kind='review_notes', body_markdown=..., work_item_id=...)`.
- Call `mcp__sapling__complete_work` with the artifact id and summary.

## Failure handling

If you cannot complete the work, call `mcp__sapling__fail_work(id, reason)` with a clear reason
and stop. Do not loop on `claim_next_work` automatically — let the user decide.
```

- [ ] **Step 2: Create `sapling-plan/SKILL.md`**

````markdown
---
name: sapling-plan
description: Quickly enqueue a planning task in Sapling. Triggers on /sapling:plan <description>.
---

# /sapling:plan

Enqueue a `plan`-type work item.

## Steps

1. Take the user's description from arguments (everything after `/sapling:plan `).
2. If a service is implied (mentioned by name), resolve it with `mcp__sapling__list_services` and grab its id.
3. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "plan",
  "title": "<short title derived from the description, max 80 chars>",
  "description_markdown": "<the full description from the user>",
  "service_id": <service id if known, otherwise omit>
}
```
````

4. Tell the user: "Queued plan task #<id>. Run /sapling:work to start it."

````

- [ ] **Step 3: Create `sapling-enqueue/SKILL.md`**

```markdown
---
name: sapling-enqueue
description: Enqueue a code or review task in Sapling. Triggers on /sapling:enqueue <code|review> <description>.
---

# /sapling:enqueue

Enqueue a `code` or `review` work item.

## Steps

1. Parse arguments: first token is `code` or `review`; the rest is the description.
2. If a service is implied, resolve via `mcp__sapling__list_services`.
3. For `review`, ask the user (if not provided) for `branch` and/or `pr_url`.
4. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "<code|review>",
  "title": "<short title>",
  "description_markdown": "<full description>",
  "service_id": <id if known>,
  "branch": "<if provided>",
  "pr_url": "<if provided>"
}
````

5. Confirm: "Queued <type> task #<id>."

````

- [ ] **Step 4: Commit**

```bash
git add packages/claude-plugin/.claude/skills
git commit -m "feat(plugin): add /sapling:work, /sapling:plan, /sapling:enqueue skills"
````

---

### Task 21: `/sapling:status` and `/sapling:context` skills

**Files:**

- Create: `packages/claude-plugin/.claude/skills/sapling-status/SKILL.md`
- Create: `packages/claude-plugin/.claude/skills/sapling-context/SKILL.md`

- [ ] **Step 1: Create `sapling-status/SKILL.md`**

```markdown
---
name: sapling-status
description: Show Sapling queue health (pending / claimed / completed counts). Triggers on /sapling:status.
---

# /sapling:status

Summarize the current state of the Sapling queue.

## Steps

1. Call `mcp__sapling__list_work` four times in parallel:
   - `{ status: 'pending' }`
   - `{ status: 'claimed' }`
   - `{ status: 'completed' }`
   - `{ status: 'failed' }`
2. Render a table:
```

PENDING: <n>
CLAIMED: <n> (in flight)
COMPLETED: <n>
FAILED: <n>

```

3. List the next 5 pending titles by `priority DESC, created_at ASC`.
4. List any FAILED items with their `failure_reason`.
```

- [ ] **Step 2: Create `sapling-context/SKILL.md`**

```markdown
---
name: sapling-context
description: Load full context for a service into the conversation (metadata, plans, recent artifacts). Triggers on /sapling:context <service>.
---

# /sapling:context

Inject everything the agent needs to ground itself before working on a service.

## Steps

1. Take the service name from arguments.
2. Call `mcp__sapling__get_service({ name: <name>, app_name: <app if needed> })`.
3. Call `mcp__sapling__list_plans({ service_id: <id> })`.
4. Call `mcp__sapling__list_artifacts({ service_id: <id> })`. Show the last 10.
5. Render a summary in this shape:
```

## Service: <name> (app: <app_name>)

- Repo: <repo_url>
- Tech: <tech_stack joined>
- Depends on: <depends_on joined>
- Conventions: <conventions text or 'none'>

## Plans (<count>)

- #<id> [<status>] <title>
- ...

## Recent artifacts (<count shown>)

- #<id> [<kind>] <title> (<created_at>)
- ...

```

6. End with: "Ready. Use /sapling:work to pick up tasks for this service."
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-plugin/.claude/skills
git commit -m "feat(plugin): add /sapling:status and /sapling:context skills"
```

---

## Phase 9: Final Polish (Task 22)

### Task 22: Makefile + final README

**Files:**

- Create: `Makefile`
- Modify: `README.md`

- [ ] **Step 1: Create `Makefile`**

```make
.PHONY: up down logs psql test nuke build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f mcp-server

psql:
	docker compose exec postgres psql -U $${POSTGRES_USER:-sapling} -d $${POSTGRES_DB:-sapling}

build:
	docker compose build

test:
	pnpm --filter mcp-server test

nuke:
	@echo "This will delete ./data/postgres. Press Ctrl-C to cancel."
	@sleep 5
	docker compose down -v
	rm -rf data/postgres
```

- [ ] **Step 2: Replace placeholder `README.md`**

````markdown
# Sapling

AI-native MCP dev workbench: Postgres-backed knowledge store and typed work queue exposed to Claude Code (and other agents) via MCP.

See the design spec for full rationale: `docs/superpowers/specs/2026-04-28-sapling-mcp-dev-workbench-design.md`.

## Quickstart

```bash
cp .env.example .env
make up                       # postgres + mcp-server in docker
curl http://127.0.0.1:3333/health
```
````

Then add the Sapling MCP to your Claude Code config (or copy `packages/claude-plugin/.claude/.mcp.json` into your project):

```json
{
  "mcpServers": {
    "sapling": { "type": "http", "url": "http://localhost:3333/mcp" }
  }
}
```

Copy `packages/claude-plugin/.claude/skills/` into your project's `.claude/skills/` directory to install the slash commands:

- `/sapling:work` — pull next task and execute it
- `/sapling:plan <desc>` — enqueue a planning task
- `/sapling:enqueue <code|review> <desc>` — enqueue a code or review task
- `/sapling:status` — queue health
- `/sapling:context <service>` — load service context

## Common commands

```bash
make up      # start (postgres + mcp-server)
make down    # stop (preserves data)
make logs    # tail mcp-server logs
make psql    # open a psql shell against the running container
make test    # run the test suite (vitest + testcontainers)
make nuke    # stop AND drop data volume + ./data/postgres (5s confirmation)
```

## Optional auth

Set `MCP_TOKEN=...` in `.env` to require a bearer token on `/mcp`. Then update your client config:

```json
{
  "mcpServers": {
    "sapling": {
      "type": "http",
      "url": "http://localhost:3333/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Layout

- `packages/mcp-server/` — Node/TypeScript MCP server (HTTP/Streamable transport, 19 tools)
- `packages/claude-plugin/` — `.mcp.json` template + skills

## Tests

Tests use [testcontainers](https://github.com/testcontainers/testcontainers-node) to spin up a real Postgres for integration tests. Docker must be running locally.

```bash
make test
```

````

- [ ] **Step 3: Verify `make test` and `make up` both work end-to-end**

Run:
```bash
make test
make up
curl http://127.0.0.1:3333/health
make down
````

Expected: tests pass; health endpoint returns `{"ok":true,"db":"up"}`.

- [ ] **Step 4: Final format + commit**

```bash
pnpm format
git add Makefile README.md
git commit -m "docs: add Makefile and finalized README"
```

---

## Done

After Task 22:

- 20 MCP tools across 4 families, all integration-tested against real Postgres.
- `claim_next_work` proven concurrency-safe via parallel-claim test.
- HTTP/Streamable transport on `localhost:3333`, optional bearer auth.
- Migrations run idempotently on container start.
- Five `/sapling:*` slash commands shipped via `packages/claude-plugin/`.
- `make up`, `make test`, `make logs`, `make psql`, `make nuke`.

The system is usable: `make up`, point Claude Code at `http://localhost:3333/mcp`, then `/sapling:plan "Add OAuth to checkout-api"` followed by `/sapling:work`.
