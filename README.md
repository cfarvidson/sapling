# Sapling

<p align="center">
  <img src="logo.png" alt="Sapling logo" width="240">
</p>

AI-native MCP dev workbench: Postgres-backed knowledge store and typed work queue exposed to Claude Code (and other agents) via MCP.

See the [design spec](docs/superpowers/specs/2026-04-28-sapling-mcp-dev-workbench-design.md) for full rationale.

## Quickstart

```bash
cp .env.example .env
make up                       # postgres + mcp-server in docker
curl http://127.0.0.1:3333/health
```

Then install the Sapling Claude Code plugin (slash commands + MCP wiring in one step):

```text
/plugin marketplace add cfarvidson/sapling
/plugin install sapling@sapling
```

That gives you these `/sapling:<name>` slash commands:

- `/sapling:work` — pull next task and execute it
- `/sapling:plan <desc>` — enqueue a planning task
- `/sapling:enqueue <code|review> <desc>` — enqueue a code or review task
- `/sapling:status` — queue health
- `/sapling:queue [<work|plan> <id> [action]]` — inspect the queue and run lifecycle actions (activate, archive, update, replace, cancel, block, unblock, retry)
- `/sapling:rules [<service> | app <app-name>] [add|replace|remove|clear …]` — manage binding rules for an app or service
- `/sapling:context <service>` — load service context
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact

If you'd rather wire the MCP server up by hand instead of installing the plugin, point your client at the running server:

```json
{
  "mcpServers": {
    "sapling": { "type": "http", "url": "http://localhost:3333/mcp" }
  }
}
```

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

- `packages/mcp-server/` — Node/TypeScript MCP server (Streamable HTTP transport, 24 tools)
- `packages/claude-plugin/` — `.mcp.json` template + skills
- `packages/runner/` — `sapling-runner` daemon: polls the queue, spawns coding-agent subprocesses up to `max_concurrent`, reaps stuck claims each tick

## Autonomous mode

`sapling-runner` is a thin polling daemon that turns a Sapling queue into autonomous coding-agent runs. Each tick it reaps stuck claims, reads the runner config, and spawns up to `max_concurrent - running` agents via `bash -lc <agent_command>`. Each spawned agent self-claims via the existing `claim_next_work` MCP tool.

```bash
# Make sure mcp-server is up (`make up`).
make runner                            # foreground; SIGINT/SIGTERM = graceful shutdown
pnpm --filter sapling-runner dev -- --once          # one tick then exit
pnpm --filter sapling-runner dev -- --max-spawn 5   # exit after 5 spawns
```

The runner reads from `SAPLING_MCP_URL` (default `http://127.0.0.1:3333/mcp`) and `MCP_TOKEN` (optional). Tunable settings live in the `runner_config` singleton table and are read via `get_runner_config` at the start of each tick. Change them with the MCP `update_runner_config` tool:

```text
update_runner_config({ max_concurrent: 4 })
update_runner_config({ agent_command: "claude --dangerously-skip-permissions -p '/sapling:work'" })
update_runner_config({ poll_interval_ms: 15000 })   # requires runner restart
```

`agent_command` and `max_concurrent` take effect on the next tick. `poll_interval_ms` is read once at startup to arm the polling timer and requires a runner restart to apply.

Defaults: `max_concurrent=1`, `poll_interval_ms=30000`, `claim_ttl_ms=7200000` (2h), `max_claim_attempts=5`. Stuck claims older than `claim_ttl_ms` are reaped on the next tick (back to `pending`, or `failed` if `attempt_count` reached `max_claim_attempts`).

## Tests

Tests use [testcontainers](https://github.com/testcontainers/testcontainers-node) to spin up a real Postgres for integration tests. Docker must be running locally.

```bash
make test
```
