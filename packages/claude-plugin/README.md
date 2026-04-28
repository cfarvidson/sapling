# Sapling — Claude Code Plugin

Slash commands and `.mcp.json` wiring for the Sapling MCP server, packaged as a Claude Code plugin so the slash commands resolve under the `sapling:` namespace (e.g. `/sapling:work`).

## Install

1. Start the MCP server: `make up` from the repo root.
2. From inside Claude Code:

   ```text
   /plugin marketplace add cfarvidson/sapling
   /plugin install sapling@sapling
   ```

   The marketplace manifest at the repo root (`.claude-plugin/marketplace.json`) points at this plugin (`packages/claude-plugin/`). Installing it registers the skills under `sapling:<name>` and wires up the MCP server connection to `http://localhost:3333/mcp`.

3. Confirm it's loaded by typing `/sapling:` and watching the autocomplete.

## Commands

- `/sapling:work` — pull next pending task and execute it
- `/sapling:plan <description>` — drop a planning task into the queue
- `/sapling:enqueue <code|review> <description>` — drop a code or review task
- `/sapling:status` — show queue health
- `/sapling:queue [<work|plan> <id> [action]]` — inspect the queue and run lifecycle actions (activate, archive, update, replace, cancel, block, unblock, retry)
- `/sapling:rules [<service> | app <app-name>] [add|replace|remove|clear …]` — manage binding rules for an app or service
- `/sapling:context <service>` — load full context for a service
- `/sapling:learn <app> [<path1> ...]` — research repos for an app; populate services, dependencies, and an architecture artifact

## Layout

```
packages/claude-plugin/
├── .claude-plugin/plugin.json     # plugin manifest (name=sapling)
├── .mcp.json                      # MCP server connection
└── skills/
    ├── work/SKILL.md              # /sapling:work
    ├── plan/SKILL.md              # /sapling:plan
    ├── queue/SKILL.md             # /sapling:queue
    ├── rules/SKILL.md             # /sapling:rules
    ├── status/SKILL.md            # /sapling:status
    ├── enqueue/SKILL.md           # /sapling:enqueue
    ├── context/SKILL.md           # /sapling:context
    └── learn/SKILL.md             # /sapling:learn
```
