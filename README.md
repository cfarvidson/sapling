# Sapling

AI-native MCP dev workbench: Postgres-backed knowledge store and typed work queue exposed to Claude Code (and other agents) via MCP.

See the design spec for full rationale: `docs/superpowers/specs/2026-04-28-sapling-mcp-dev-workbench-design.md`.

## Quickstart

```bash
cp .env.example .env
make up                       # postgres + mcp-server in docker
curl http://127.0.0.1:3333/health
```

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
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact

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

- `packages/mcp-server/` — Node/TypeScript MCP server (Streamable HTTP transport, 20 tools)
- `packages/claude-plugin/` — `.mcp.json` template + skills

## Tests

Tests use [testcontainers](https://github.com/testcontainers/testcontainers-node) to spin up a real Postgres for integration tests. Docker must be running locally.

```bash
make test
```
