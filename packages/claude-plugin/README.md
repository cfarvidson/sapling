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
