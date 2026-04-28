---
name: sapling-rules
description: View, add, replace, or clear binding instructions ("rules") for an app or service in Sapling. Rules are loaded by /sapling:work and treated as non-negotiable. Triggers on /sapling:rules.
---

# /sapling:rules

Manage app- and service-level rules that govern how `/sapling:work` executes
code/review/plan tasks. Rules live in `apps.conventions` (app-wide) and
`services.conventions` (service-specific). They are free-text markdown — one
rule per line is the convention, but anything goes.

Examples of rules:

- `Always publish review notes as a GitHub PR comment.`
- `Never push directly to main; always open a PR with cfarvidson/ branch prefix.`
- `Tests must run inside docker-compose, not host node.`

## Forms

```
/sapling:rules                                        — list every app/service that has rules
/sapling:rules <service>                              — show one service's rules (+ app rules it inherits)
/sapling:rules app <app-name>                         — show one app's rules
/sapling:rules <service> add "<rule>"                 — append a line to the service rules
/sapling:rules app <app-name> add "<rule>"            — append a line to the app rules
/sapling:rules <service> replace                      — replace the full body (asks for new text)
/sapling:rules app <app-name> replace                 — replace app body
/sapling:rules <service> remove "<substring>"         — delete the matching line(s)
/sapling:rules <service> clear                        — set conventions to NULL
/sapling:rules app <app-name> clear                   — set conventions to NULL
```

## Steps

### Overview (no args)

1. `mcp__sapling__list_apps()` → keep apps with non-empty `conventions`.
2. `mcp__sapling__list_services()` → keep services with non-empty `conventions`.
3. Render two sections:

```
APP RULES
  iris        (id 1)
    - Always publish review notes as a GitHub PR comment.
    …
SERVICE RULES
  iris-upload-portal        (id 33, app=iris)
    - Run tests inside docker-compose.
    …
```

### Show one (`<service>` or `app <app-name>`)

- For a service: `mcp__sapling__get_service({ name, app_name })` (or by id), then `mcp__sapling__get_app({ id: service.app_id })` so you can show inherited app rules separately.
- Print the service's `conventions` and the app's `conventions` clearly labelled.

### Add a rule

- Service: read current `conventions`, append `\n- <rule>` (preserving any existing trailing newline rules), call `mcp__sapling__update_service({ id, conventions })`.
- App: same with `update_app({ id, conventions })`.
- Confirm with the new full body so the user can sanity-check the result.

### Replace

- Ask the user for the full new body in chat (multi-line). Show the previous body for reference. Then `update_service`/`update_app` with the new value.

### Remove

- Read current body, drop any line that contains the substring (case-insensitive). Confirm what was removed before calling update.
- If no line matches, tell the user and stop — don't write back the same body.

### Clear

- `update_service({ id, conventions: null })` or `update_app({ id, conventions: null })`. Confirm.

## How rules feed `/sapling:work`

`/sapling:work` already loads `services.conventions` for code/review tasks.
It must also load `apps.conventions` (`get_app({ id: service.app_id })`) and
treat both as binding constraints when planning, coding, or reviewing — not
as suggestions. If a rule conflicts with the user's task, halt and ask
rather than silently violating it.
