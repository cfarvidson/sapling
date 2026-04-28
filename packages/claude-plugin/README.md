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
- `/sapling:queue [<work|plan> <id> [action]]` — inspect the queue and run lifecycle actions (activate, archive, update, replace, cancel, block, unblock, retry)
- `/sapling:rules [<service> | app <app-name>] [add|replace|remove|clear …]` — manage binding rules for an app or service
- `/sapling:context <service>` — load full context for a service
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact
