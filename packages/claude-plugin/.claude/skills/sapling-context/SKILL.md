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
