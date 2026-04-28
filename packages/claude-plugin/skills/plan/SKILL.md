---
name: plan
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

4. Tell the user: "Queued plan task #<id>. Run /sapling:work to start it."
