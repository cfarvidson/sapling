import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';
import { nextCronTick, nextNCronTicks, validateCron, validateTimezone } from '../cron.js';
import { findScheduleByIdOrName, listSchedules, recentRuns } from '../schedules/db.js';
import { fireSchedule } from '../schedules/fire.js';
import { createLogger } from '../logger.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const CreateInput = {
  name: z.string().min(1),
  source_type: z.enum(['app', 'github_org']),
  app_name: z.string().min(1),
  github_org: z.string().min(1).optional(),
  cron_expr: z.string().min(1),
  timezone: z.string().default('UTC'),
  overlap_policy: z.enum(['skip_if_running', 'always_fire']).default('skip_if_running'),
  title_template: z.string().min(1),
  description_md: z.string().min(1),
  definition_of_done_md: z.string().min(1),
};

const NotPatchable = z
  .never({
    errorMap: () => ({ message: 'field is not patchable; recreate the schedule to change it' }),
  })
  .optional();

const UpdateInput = {
  id: z.number().int().positive(),
  cron_expr: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  overlap_policy: z.enum(['skip_if_running', 'always_fire']).optional(),
  title_template: z.string().min(1).optional(),
  description_md: z.string().min(1).optional(),
  definition_of_done_md: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  name: NotPatchable,
  source_type: NotPatchable,
  app_id: NotPatchable,
  github_org: NotPatchable,
};

export function registerSchedules(server: McpServer, db: Db): void {
  server.registerTool(
    'create_schedule',
    {
      description:
        'Create a recurring project schedule. source_type="app" runs against existing services; ' +
        '"github_org" discovers repos live from a GitHub org at fire time (requires runner_config.github_token).',
      inputSchema: CreateInput,
    },
    async (input) => {
      const cronErr = validateCron(input.cron_expr);
      if (cronErr) return errorToToolResult(new AppError('invalid_input', cronErr));
      const tzErr = validateTimezone(input.timezone);
      if (tzErr) return errorToToolResult(new AppError('invalid_input', tzErr));
      if (input.source_type === 'github_org' && !input.github_org) {
        return errorToToolResult(
          new AppError('invalid_input', 'github_org is required when source_type=github_org'),
        );
      }

      const app = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
        input.app_name,
      ]);
      if (app.rowCount === 0)
        return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));

      const next = nextCronTick(input.cron_expr, input.timezone, new Date());
      try {
        const { rows } = await db.query(
          `INSERT INTO schedules
             (name, source_type, app_id, github_org, cron_expr, timezone, overlap_policy,
              title_template, description_md, definition_of_done_md, next_run_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            input.name,
            input.source_type,
            app.rows[0].id,
            input.source_type === 'github_org' ? input.github_org : null,
            input.cron_expr,
            input.timezone,
            input.overlap_policy,
            input.title_template,
            input.description_md,
            input.definition_of_done_md,
            next,
          ],
        );
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_schedule',
    {
      description: 'Fetch a schedule plus last run, last 5 runs, and the next 3 cron fire times.',
      inputSchema: {
        id_or_name: z.union([z.number().int().positive(), z.string().min(1)]),
      },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id_or_name);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const runs = await recentRuns(db, sched.id, 5);
      const next3 = nextNCronTicks(sched.cron_expr, sched.timezone, new Date(), 3);
      return ok({
        schedule: sched,
        last_run: runs[0] ?? null,
        last_5_runs: runs,
        next_3_fires: next3.map((d) => d.toISOString()),
      });
    },
  );

  server.registerTool(
    'list_schedules',
    {
      description:
        'List schedules. Optional filters: app_name, source_type, enabled. Returns full rows.',
      inputSchema: {
        app_name: z.string().min(1).optional(),
        source_type: z.enum(['app', 'github_org']).optional(),
        enabled: z.boolean().optional(),
      },
    },
    async (input) => {
      let appId: number | undefined;
      if (input.app_name) {
        const a = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          input.app_name,
        ]);
        if (a.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `app ${input.app_name} not found`));
        appId = a.rows[0].id;
      }
      const rows = await listSchedules(db, {
        app_id: appId,
        source_type: input.source_type,
        enabled: input.enabled,
      });
      return ok(rows);
    },
  );

  server.registerTool(
    'update_schedule',
    {
      description:
        'Patch a schedule. source_type, app_id, github_org, name are NOT patchable — recreate. ' +
        'Changing cron_expr or timezone recomputes next_run_at.',
      inputSchema: UpdateInput,
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));

      const sets: string[] = [];
      const vals: unknown[] = [];
      const patchable = [
        'cron_expr',
        'timezone',
        'overlap_policy',
        'title_template',
        'description_md',
        'definition_of_done_md',
        'enabled',
      ] as const;
      for (const k of patchable) {
        const v = input[k];
        if (v === undefined) continue;
        if (k === 'cron_expr') {
          const err = validateCron(v as string);
          if (err) return errorToToolResult(new AppError('invalid_input', err));
        }
        if (k === 'timezone') {
          const err = validateTimezone(v as string);
          if (err) return errorToToolResult(new AppError('invalid_input', err));
        }
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
      if (sets.length === 0)
        return errorToToolResult(
          new AppError('invalid_input', 'update_schedule requires at least one patchable field'),
        );

      const newCron = input.cron_expr ?? sched.cron_expr;
      const newTz = input.timezone ?? sched.timezone;
      const next = nextCronTick(newCron, newTz, new Date());
      vals.push(next);
      sets.push(`next_run_at = $${vals.length}`);
      sets.push(`updated_at = now()`);

      vals.push(sched.id);
      const { rows } = await db.query(
        `UPDATE schedules SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
        vals,
      );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'delete_schedule',
    {
      description:
        'Hard delete a schedule. Cascades schedule_runs. Does not touch spawned projects.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const { rowCount } = await db.query(`DELETE FROM schedules WHERE id = $1`, [input.id]);
      if (rowCount === 0) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      return ok({ deleted: input.id });
    },
  );

  server.registerTool(
    'enable_schedule',
    {
      description: 'Enable a schedule. Recomputes next_run_at from now. Does not catch up.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const next = nextCronTick(sched.cron_expr, sched.timezone, new Date());
      const { rows } = await db.query(
        `UPDATE schedules SET enabled = TRUE, next_run_at = $2, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [input.id, next],
      );
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'disable_schedule',
    {
      description: 'Disable a schedule. In-flight spawned projects are NOT cancelled.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const { rows, rowCount } = await db.query(
        `UPDATE schedules SET enabled = FALSE, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [input.id],
      );
      if (rowCount === 0) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      return ok(rows[0]);
    },
  );

  server.registerTool(
    'run_schedule_now',
    {
      description:
        'Fire a schedule out-of-band immediately. Honors overlap_policy (a skip_if_running schedule with a non-terminal prior project will record a skipped_overlap run). Records a schedule_runs row.',
      inputSchema: { id: z.number().int().positive() },
    },
    async (input) => {
      const sched = await findScheduleByIdOrName(db, input.id);
      if (!sched) return errorToToolResult(new AppError('not_found', 'schedule not found'));
      const log = createLogger('info');
      const outcome = await fireSchedule({ db, schedule: sched, log, now: new Date() });
      return ok(outcome);
    },
  );
}
