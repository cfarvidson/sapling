---
name: plan
description: Quickly enqueue a planning task in Sapling. Triggers on /sapling:plan <description>.
---

# /sapling:plan

Enqueue a `plan`-type work item.

## Steps

1. Parse arguments:
   - Optional `team <name>` pair: pin a specific team. Resolve as in `/sapling:enqueue`.
   - Everything else is the description.
2. If a service is implied (mentioned by name), resolve it with `mcp__sapling__list_services` and grab its id.
3. Call `mcp__sapling__enqueue_work`:

```json
{
  "type": "plan",
  "title": "<short title derived from the description, max 80 chars>",
  "description_markdown": "<the full description from the user>",
  "service_id": <service id if known, otherwise omit>,
  "team_id": <id if `team <name>` was passed>
}
```

4. Tell the user: "Queued plan task #<id>. Run /sapling:work to start it." If a team was attached (explicit or via default), include "team=<team_name>" in the confirmation.
