# block_project cascade + awaiting_input visibility — design

**Date:** 2026-05-10
**Status:** Approved (brainstorming)
**Scope:** packages/mcp-server, packages/runner, packages/claude-plugin, docker-compose.yml, SPEC.md

## Why

Two real bugs and one workflow gap, all in the same neighborhood.

1. **`block_project` does not cascade.** It flips the project to `blocked` and pauses the auto-enqueue triggers in `advanceProjectAfterWorkCompletion`, but pending children keep getting claimed by the runner and claimed children keep executing. The other lifecycle verb in the same family — `cancel_project` — cascades via `cancel_work` to all non-terminal children. The asymmetry is silently destructive: an operator who "blocks" a project still gets new commits and merged PRs.
2. **`unblock_project` only replays the most recent completion.** Lines 494–510 of `packages/mcp-server/src/tools/projects.ts` fetch the single most-recent `completed` child and call `advanceProjectAfterWorkCompletion` once. If three completions happened during the blocked window — e.g., three code items finished under three different plans — only the last one drives an advance pass. The other two never trigger their per-plan reviews.
3. **`awaiting_input` is invisible in practice.** When an autonomous agent calls `request_human_input`, the work item flips to `awaiting_input` and waits forever. The only surfaces today are `/sapling:status` (count only) and `/sapling:human` (which the operator must already know to run). With the runner running in the background, the operator almost never invokes `/sapling:work` interactively — so the natural "you have paused work" prompts never fire. Items can sit for days.

This design fixes (1) and (2) and adds operator-targeted, opt-in attention mechanisms for (3) — including a self-hosted ntfy service that reaches the phone.

## What changes

### 1. `block_project(id, reason)` — cascade

Wrap the existing single UPDATE in a transaction and add a cascade UPDATE:

```sql
UPDATE work_items
   SET status = 'blocked',
       failure_reason = 'project blocked: ' || $reason,
       updated_at = now()
 WHERE project_id = $id
   AND status IN ('pending', 'awaiting_input');
```

- `claimed` rows are intentionally **not** touched. Sapling cannot kill the spawned agent process; flipping the row to `blocked` while the agent runs would create a status that does not reflect reality. The agent finishes, calls `complete_work`, and the existing helper guard in `advanceProjectAfterWorkCompletion` (early-returns when project status is not `scoping`/`in_progress`) prevents any further auto-enqueue. The unblock-replay loop later catches this completion (see § 2).
- `awaiting_input` rows **are** included in the cascade. Otherwise a human providing input via `provide_human_input` would resurrect the item to `pending` and the runner would claim it on a project that the operator just blocked. The `pending_questions` and `answers` artifacts are preserved on the row; on unblock, the row returns to `pending` and the next agent re-reads both artifacts. This is a minor UX wrinkle, not a data loss.
- The `'project blocked: '` prefix on `failure_reason` is the cascade marker. It is a reserved prefix: operators must not call `block_work` with a reason that starts with this exact string (documented in SPEC § 7).
- Returns `{ project, cascade_blocked_count }`.

Idempotency on the project row is unchanged: blocking an already-`blocked` project still rejects with `conflict`.

### 2. `unblock_project(id)` — cascade-unblock + replay-all (bug fix)

Atomic transaction:

1. Recompute project target status from children (existing): `scoping` if a scoping plan-type work item is still in flight, else `in_progress`.
2. **New cascade-unblock:**
   ```sql
   UPDATE work_items
      SET status = 'pending',
          failure_reason = NULL,
          updated_at = now()
    WHERE project_id = $id
      AND status = 'blocked'
      AND failure_reason LIKE 'project blocked: %';
   ```
   The `LIKE` filter is the marker that distinguishes cascade-blocked from operator-blocked-for-other-reasons. An operator who manually called `block_work(child_id, 'project blocked: ...')` will have that item swept by cascade-unblock — documented as a reserved prefix.
3. **Replay-all (the bug fix):** iterate every `completed` non-verifier child of the project in `completed_at` order and call `advanceProjectAfterWorkCompletion(client, projectId, child)` for each. The helper's existing guards are already idempotent:
   - The per-plan-review branch (lines 615–639) gates on `remaining = 0 AND reviewExists = 0`.
   - The DoD-verifier branch (lines 642–665) gates on `remainingNonVerifier = 0 AND verifierExists = 0`.
   - Replaying a completion whose triggers already fired is a no-op.
4. Returns `{ project, cascade_unblocked_count }`.

### 3. `awaiting_input` visibility — louder pull surfaces

Two cheap changes, no schema impact:

- **`/sapling:status`**: alongside the existing count, surface the age of the oldest paused item. Format: `awaiting_input: 3 (oldest 4h)`. Age = `now() - updated_at` while `status = 'awaiting_input'`. The skill computes this from the existing `list_work` results — no new tool.
- **Runner stdout filter**: today the filter suppresses idle ticks (`reaped == 0 && spawned == 0`) except for a heartbeat every 20th idle tick. Add a rule: if `awaiting_input_count > 0` on a tick, print `⚠ awaiting_input: N (oldest Xh)` regardless of idle status. Also goes to the JSON file log as a structured event `{ event: 'awaiting_input', count, oldest_age_ms }`.

The previously considered `/sapling:work` banner is dropped: the runner-in-background workflow means `/sapling:work` is rarely invoked interactively, so the banner would not fire when needed.

### 4. Self-hosted ntfy + runner notifier

#### docker-compose.yml

A third service alongside `mcp-server` and `postgres`:

```yaml
ntfy:
  image: binwiederhier/ntfy:latest
  command: serve
  environment:
    - TZ=UTC
    - NTFY_BASE_URL=http://localhost:8080
    - NTFY_CACHE_FILE=/var/cache/ntfy/cache.db
    - NTFY_AUTH_FILE=/var/lib/ntfy/user.db
    - NTFY_BEHIND_PROXY=false
    - NTFY_LISTEN_HTTP=:80
  ports:
    - '127.0.0.1:8080:80'
  volumes:
    - ./data/ntfy/cache:/var/cache/ntfy
    - ./data/ntfy/lib:/var/lib/ntfy
  restart: unless-stopped
```

- Loopback-bound by default, matching the existing security posture (mcp-server and postgres are also loopback-only).
- Volume `./data/ntfy/{cache,lib}` mirrors the `./data/postgres` pattern; both go in `.gitignore`.
- Auth disabled by default; safe because the port is not network-reachable. Auth must be enabled before exposing the service (see Phone reachability below).

#### Phone reachability

Loopback ntfy cannot be reached from the phone. README documents three exposure paths; spec recommends Tailscale.

- **Recommended — Tailscale**: bind ntfy to the tailnet IP. Both Mac and phone on the same tailnet. Works anywhere both devices are online. No public exposure. README example shows the port mapping change and the ntfy `NTFY_BASE_URL` adjustment.
- **LAN binding**: change `127.0.0.1:8080:80` to `0.0.0.0:8080:80`. Phone subscribes via Mac's LAN IP. Works only on the same Wi-Fi.
- **Cloudflare Tunnel / ngrok**: public URL via tunnel; ntfy auth required. Most setup; works anywhere with internet.

The README documents all three; the spec recommends Tailscale and explicitly notes that auth must be turned on before any non-loopback exposure.

#### runner_config additions (migration 009)

Three new columns on the singleton `runner_config` row, all nullable / with defaults so existing rows continue to work:

| Column                         | Type   | Default    | Notes                                                                                         |
| ------------------------------ | ------ | ---------- | --------------------------------------------------------------------------------------------- |
| `ntfy_url`                     | `text` | `NULL`     | Full URL including topic, e.g. `http://localhost:8080/sapling`. `NULL` disables the notifier. |
| `awaiting_input_nag_age_ms`    | `int`  | `3600000`  | Age threshold (1h) before an `awaiting_input` item is eligible for a nag.                     |
| `awaiting_input_nag_repeat_ms` | `int`  | `21600000` | Minimum interval (6h) between repeat nags for the same item.                                  |

`update_runner_config` accepts these as optional partial fields (mirrors existing pattern).

#### Notifier loop

In the runner tick, after the existing reap → list pending step:

1. List `awaiting_input` work items via `list_work({ status: 'awaiting_input' })`.
2. For each item: `age = now() - updated_at`. If `age >= awaiting_input_nag_age_ms` and `(now() - lastNotifiedAt[id]) >= awaiting_input_nag_repeat_ms` (or `lastNotifiedAt[id]` is unset):
   - POST to `ntfy_url` with title `Sapling: awaiting input` and body containing work id, title, age, and a hint to run `/sapling:human <id>`.
   - On success: `lastNotifiedAt[id] = now()`.
   - On HTTP failure: log a structured `notify_error` line; do not crash the tick.
3. If `ntfy_url` is `NULL`, skip step 2 entirely.

`lastNotifiedAt` is **in-memory** in the runner (`Map<workId, Date>`). Tradeoff: a runner restart re-nags once per still-stale item. Acceptable for v1; a `work_items.notified_at` column can be added later if double-pings become annoying.

No new dependency: the runner uses `fetch` directly.

### 5. SPEC.md changes

The maintenance rule (CLAUDE.md, SPEC § 16) requires updating SPEC.md in the same change.

- **§ 2 (Goals and non-goals)** — narrow the outbound-transports non-goal:
  - Old: `Webhooks, event bus, metrics export, outbound transports of any kind (discoverability is pull-based).`
  - New: `Webhooks, event bus, metrics export. Discoverability is pull-based; opt-in operator-targeted notifications via the runner-side ntfy notifier are permitted as an attention mechanism for awaiting_input items, not as a general transport.`
- **§ 3 (Architecture)** — add `ntfy` to the docker-compose box in the diagram; note that the runner POSTs to it directly.
- **§ 7 (MCP tool surface)** — update `block_project` and `unblock_project` rows: cascade semantics, replay-all behavior, return-shape change, reserved `'project blocked: '` prefix.
- **§ 8 (Work-item lifecycle)** — add cascade arrows to the project lifecycle diagram (`block_project` → blocks pending + awaiting_input children; `unblock_project` → unblocks them and replays all completions).
- **§ 11 (Autonomous mode)** — document the notifier loop step in the tick algorithm and the in-memory throttle.
- **§ 13 (Configuration surface)** — add `ntfy_url`, `awaiting_input_nag_age_ms`, `awaiting_input_nag_repeat_ms` rows.
- **§ 5 (Data model)** — add migration 009 row to the migrations table.

### Files touched

| File                                                        | Change                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/mcp-server/src/tools/projects.ts`                 | `block_project`: wrap in tx + cascade UPDATE. `unblock_project`: cascade UPDATE + replay-all loop. Return shape changes. |
| `packages/mcp-server/src/schema/009_runner_ntfy_config.sql` | New migration: add `ntfy_url`, `awaiting_input_nag_age_ms`, `awaiting_input_nag_repeat_ms` to `runner_config`.           |
| `packages/runner/src/loop.ts`                               | Call notifier after listing pending.                                                                                     |
| `packages/runner/src/notifier.ts`                           | New: in-memory throttle + ntfy POST.                                                                                     |
| `packages/runner/src/logger.ts`                             | Heartbeat: surface `awaiting_input` count + oldest age when count > 0.                                                   |
| `packages/claude-plugin/skills/status/SKILL.md`             | Show oldest age next to `awaiting_input` count.                                                                          |
| `packages/claude-plugin/.claude-plugin/plugin.json`         | Patch bump (skill output change).                                                                                        |
| `docker-compose.yml`                                        | Add `ntfy` service.                                                                                                      |
| `.gitignore`                                                | Add `./data/ntfy/`.                                                                                                      |
| `README.md`                                                 | ntfy setup + Tailscale (recommended) / LAN / Cloudflare Tunnel exposure paths + auth note.                               |
| `SPEC.md`                                                   | Sections listed above.                                                                                                   |
| `packages/mcp-server/test/projects.test.ts` (or equivalent) | Cascade tests, replay-all test, marker prefix test, idempotency tests.                                                   |
| `packages/runner/test/notifier.test.ts`                     | Throttle behavior, `ntfy_url=NULL` no-op, HTTP failure does not crash tick.                                              |

### Test coverage

- `block_project` cascades `pending` and `awaiting_input` children to `blocked` with the marker prefix.
- `block_project` does **not** touch `claimed`, `completed`, `cancelled`, `failed`, or already-`blocked` children.
- `block_project` on already-`blocked` project returns `conflict`.
- `unblock_project` cascade-unblocks rows whose `failure_reason` starts with `'project blocked: '`; leaves operator-blocked rows with other reasons alone.
- `unblock_project` replay handles `N > 1` completions during the blocked window: each completion that _would have_ triggered a per-plan review or DoD verifier produces exactly one trigger after replay (idempotent under double-replay).
- Notifier respects `awaiting_input_nag_age_ms` (no nag below threshold), `awaiting_input_nag_repeat_ms` (no double-nag inside the window), and `ntfy_url=NULL` (skip entirely).
- Notifier HTTP failure logs and continues; tick does not crash.

## Out of scope

- `claim_next_work` does **not** gain a project-status gate. Cascaded children's own `blocked` status is sufficient to keep them out of the queue. A claim while a project is blocked can only happen for a child that is already `claimed` (and thus untouched) or one that an operator separately re-set to `pending`.
- No new column for cascade marking. The `'project blocked: '` reason prefix is the v1 mechanism. If the prefix-collision risk bites in practice, adding `work_items.blocked_by_project_id` (FK → projects, ON DELETE SET NULL) is a clean migration 010.
- No mechanism to forcibly terminate an in-flight agent process. Sapling remains the workbench, not the worker.
- Other gaps surfaced during brainstorming — timing analytics, a tool to reset `attempt_count`, and a deeper rework of `failure_reason` taxonomy — remain open as separate work.
- Plugin major bump: not warranted; `/sapling:status` output is additive (new column in the line, not a new structure).

## Open question (post-merge tuning)

Default values for `awaiting_input_nag_age_ms` (1h) and `awaiting_input_nag_repeat_ms` (6h) are guesses. Tune after a week of real use.
