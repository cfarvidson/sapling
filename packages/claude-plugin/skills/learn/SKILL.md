---
name: learn
description: Research code repos for an app and populate Sapling with services, dependencies, and an architecture summary. Triggers on /sapling:learn.
---

# /sapling:learn

Research a set of code repos for an app and populate Sapling's product knowledge: services, tech_stack, depends_on, and a markdown architecture summary attached as an artifact.

This skill does NOT add new MCP tools. It uses these existing Sapling MCP tools:

- `mcp__sapling__list_apps`
- `mcp__sapling__register_app`
- `mcp__sapling__list_services`
- `mcp__sapling__register_service`
- `mcp__sapling__update_service`
- `mcp__sapling__attach_artifact`

## Invocation Forms

Parse the user's arguments to derive `appName` and `repoPaths[]`:

| Form                                       | Behavior                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sapling:learn <app> <path1> [path2 ...]` | Use the given repo paths as services.                                                                                                                                                                                |
| `/sapling:learn <app> <single-dir>`        | If `<single-dir>` contains `.git/`, treat as one service. Otherwise scan immediate children of `<single-dir>` for `.git/` subdirs; each match is a service.                                                          |
| `/sapling:learn <app>`                     | No paths. Read existing services for the app via `list_services`; use each `repo_url` if it points to a local path (`file://...` or absolute filesystem path). Fail with a clear message if nothing usable is found. |

If parsing yields no `appName`, tell the user: "Usage: `/sapling:learn <app> [<path1> ...]`. Example: `/sapling:learn checkout ~/code/checkout-api ~/code/checkout-web`." and stop.

## Steps

### 1. Resolve the app

1. Call `mcp__sapling__list_apps` with `{}`.
2. If `<appName>` is not in the result, call `mcp__sapling__register_app` with `{ name: appName }`. Capture the returned `id`.
3. Otherwise grab the existing app's `id` from the list.

### 2. Resolve the repo paths

Apply the table above to derive `repoPaths[]`. For form 3 (no args), call `mcp__sapling__list_services({ app_name: appName })` and collect each service's `repo_url` IF it is either a `file://` URL or an absolute filesystem path. Strip the `file://` prefix.

Validate each path:

- Must exist on disk.
- Must contain a `.git` entry (file or directory).

If a path fails either check, record a warning (`"<path>: skipped — not a git repo"`) and continue. Don't abort.

### 3. Detection pass — per repo

For each valid `repoPath`, produce a JSON observation:

```json
{
  "name": "<sanitized directory name>",
  "repo_url": "<remote URL or file://...>",
  "tech_stack": ["..."],
  "depends_on": ["..."],
  "description": "<one line>",
  "conventions": "<absolute path to CLAUDE.md/AGENTS.md or null>"
}
```

#### name

Take the basename of `repoPath`. Lowercase it. Replace any character matching `[^a-z0-9-]` with `-`. Collapse runs of `-`. Trim leading/trailing `-`.

#### repo_url

Run `git -C <repoPath> remote get-url origin`. If it succeeds and prints a non-empty value, use it. Otherwise use `file://<absolute repoPath>`.

#### tech_stack

Look for these manifests at the repo root and add the corresponding tags:

- `package.json` → add `node`, `typescript` (if `tsconfig.json` exists or `typescript` is in deps), and any of `react`, `next`, `express`, `fastify`, `hono`, `nestjs`, `vue`, `svelte`, `astro` if present in deps.
- `pyproject.toml` or `requirements.txt` → add `python`, plus any of `django`, `flask`, `fastapi` from deps.
- `Gemfile` → add `ruby`, plus `rails` if `rails` gem is listed.
- `go.mod` → add `go`.
- `Cargo.toml` → add `rust`.
- `pom.xml` or `build.gradle` → add `java`/`kotlin` accordingly.
- `composer.json` → add `php`, plus `laravel`/`symfony` if found.

Also scan deps for DB/queue drivers and add tags:

- `pg`, `psycopg`, `psycopg2`, `psycopg3`, `pq`, `sqlx` → `postgres`
- `mysql`, `mysql2`, `pymysql` → `mysql`
- `redis`, `ioredis`, `rb-redis` → `redis`
- `mongodb`, `mongoose`, `pymongo` → `mongodb`
- `kafkajs`, `confluent-kafka`, `sarama` → `kafka`
- `amqplib`, `pika` → `rabbitmq`

De-duplicate the resulting list. Lower-case all entries.

#### depends_on

This is a list of OTHER service names within this app. Use these signals, in order:

1. **Workspace siblings.** If the repo is part of a monorepo manifest (`workspaces` field in `package.json`, `pnpm-workspace.yaml`, or sibling crates in `Cargo.toml`), list the sibling package names that match other detected services in this app.
2. **Internal HTTP base URLs.** Grep source files (excluding `node_modules`, `dist`, `build`, `.git`, `__pycache__`, `target`) for strings of the form `http(s)?://<word>(:port)?` where `<word>` matches the name of another service in this app (case-insensitive).
3. **Message-bus topic names.** If you see a topic literal that exactly matches another service's name, count it.

The result is a list of service names (strings). De-duplicate. Empty list is fine.

#### description

Read up to the first 200 lines of `README.md` (or `README`, `Readme.md`, `readme.md`). Read `package.json`'s `"description"` field if present. Synthesize a single-sentence (max ~120 chars) description. If you have nothing to go on, set this to null.

#### conventions

Check for `CLAUDE.md` or `AGENTS.md` at the repo root (in that priority order). If found, store the absolute path as a string. Otherwise null.

### 4. Persist findings — per repo

For each observation:

1. Look up the existing service in this app by `name`. Use the `list_services({ app_name })` result fetched earlier (or fetch fresh).
2. **If absent:** call `mcp__sapling__register_service` with the observation fields. Pass `null`/omit for any null detection fields.
3. **If present:** apply MERGE SEMANTICS and call `mcp__sapling__update_service`:
   - **`tech_stack`** and **`depends_on`**: UNION the detected list with the existing list. De-duplicate.
   - **`description`**, **`conventions`**, **`repo_url`**: only set if the existing value is null or empty string. Do NOT clobber a non-empty value.
   - If the existing `repo_url` differs from the detected `repo_url`, do NOT change it; record a warning: `"warning: <name> repo_url differs (db=<existing>, detected=<new>); not changed"`.
   - Build the patch object with only the fields you actually want to update; pass `id` and the changed fields. Skip the call entirely if there are no fields to change.

Capture the resulting service id for the next step.

### 5. Architecture summary

Once all repos are processed, draft a single markdown body covering the whole app. Use this exact template:

```markdown
# Architecture — <appName>

_Generated by /sapling:learn on <YYYY-MM-DD>_

## Services

- **<service-1>** (<tech_stack joined with ", ">) — <description or "no description"> — repo: <repo_url>
- **<service-2>** ...

## Dependencies

- <service-a> → <service-b> (<reason: "shared package" / "HTTP" / "topic">)
- ...
  (omit this section if there are no detected dependencies)

## Entry points

- <service-x> exposes HTTP routes on port <N>
- <service-y> consumes messages from topic <T>
  (omit this section if you found nothing concrete)

## Notes

- <orphans, circular deps, unfamiliar tech, open questions>
  (omit if you have nothing to add)
```

For each service id captured in step 4, call `mcp__sapling__attach_artifact` with:

```json
{
  "kind": "architecture",
  "title": "Architecture — <appName>",
  "body_markdown": "<the rendered markdown above>",
  "service_id": <id>
}
```

This means `/sapling:context <any-service-in-this-app>` will surface the architecture artifact for that app.

### 6. Final summary to the user

Print a concise report:

```
/sapling:learn <appName>
  ✓ created  <name> (id=<id>)  tech_stack=[...]  depends_on=[...]
  ✓ updated  <name> (id=<id>)  added=[...]
  ⚠ skipped  <path> — <reason>
  ⚠ warning  <name> repo_url differs (db=..., detected=...); not changed

  Attached architecture artifact (id=<id1>, id=<id2>, ...) to <N> services.
```

End with: "Run `/sapling:context <service>` to load the new context into a session, or `/sapling:plan <desc>` to queue planning work."

## Failure handling

If an MCP call returns an error, surface it inline (`"✗ error  <name>: <message>"`) and continue to the next repo. Do not retry. Do not abort the run.

If form 3 (no paths) is used and no usable local `repo_url` is found, fail before doing any work:

> Cannot infer repos for app '<appName>': no services have a local repo_url. Pass repo paths explicitly, e.g. `/sapling:learn <appName> ~/code/<repo1> ~/code/<repo2>`.
