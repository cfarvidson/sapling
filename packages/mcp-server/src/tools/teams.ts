import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db.js';
import { AppError, errorToToolResult, mapPgError } from '../errors.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const RoleInput = z.object({
  name: z.string().min(1),
  description_md: z.string().min(1),
  subagent_type: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative().optional(),
});

async function loadTeamWithRoles(db: Db, id: number): Promise<Record<string, unknown> | null> {
  const t = await db.query(`SELECT * FROM teams WHERE id = $1`, [id]);
  if (t.rowCount === 0) return null;
  const r = await db.query(
    `SELECT * FROM team_roles WHERE team_id = $1 ORDER BY ordinal ASC, id ASC`,
    [id],
  );
  return { ...t.rows[0], roles: r.rows };
}

export function registerTeams(server: McpServer, db: Db): void {
  server.registerTool(
    'create_team',
    {
      description:
        'Create a team and its initial roles in one call. Set app_id to scope the team to one app, or omit for a global team.',
      inputSchema: {
        name: z.string().min(1),
        app_id: z.number().int().positive().optional(),
        description: z.string().optional(),
        lead_prompt_md: z.string().min(1),
        roles: z.array(RoleInput).min(1),
      },
    },
    async (input) => {
      try {
        const client = await db.connect();
        let teamId: number;
        try {
          await client.query('BEGIN');
          const team = await client.query(
            `INSERT INTO teams(name, app_id, description, lead_prompt_md)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [input.name, input.app_id ?? null, input.description ?? null, input.lead_prompt_md],
          );
          teamId = (team.rows[0] as { id: number }).id;
          for (const role of input.roles) {
            await client.query(
              `INSERT INTO team_roles(team_id, name, description_md, subagent_type, ordinal)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                teamId,
                role.name,
                role.description_md,
                role.subagent_type ?? null,
                role.ordinal ?? 0,
              ],
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        const full = await loadTeamWithRoles(db, teamId);
        return ok(full);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'get_team',
    {
      description:
        'Fetch a team by id, or by (name, app_id?). When looking up by name, omit app_id (or pass null) for the global team.',
      inputSchema: z
        .object({
          id: z.number().int().positive().optional(),
          name: z.string().min(1).optional(),
          app_id: z.number().int().positive().nullable().optional(),
        })
        .refine((v) => v.id !== undefined || v.name !== undefined, {
          message: 'must provide id or name',
        }),
    },
    async (input) => {
      let id = input.id;
      if (id === undefined) {
        const { rows } = input.app_id
          ? await db.query(`SELECT id FROM teams WHERE name = $1 AND app_id = $2`, [
              input.name,
              input.app_id,
            ])
          : await db.query(`SELECT id FROM teams WHERE name = $1 AND app_id IS NULL`, [input.name]);
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `team ${input.name} not found`));
        id = (rows[0] as { id: number }).id;
      }
      const full = await loadTeamWithRoles(db, id);
      if (!full) return errorToToolResult(new AppError('not_found', `team ${id} not found`));
      return ok(full);
    },
  );

  server.registerTool(
    'list_teams',
    {
      description:
        'List teams with role counts. Filter by app_id or app_name to scope to one app (use neither to see global + all apps).',
      inputSchema: {
        app_id: z.number().int().positive().optional(),
        app_name: z.string().min(1).optional(),
      },
    },
    async ({ app_id, app_name }) => {
      let resolved: number | null = app_id ?? null;
      if (resolved === null && app_name) {
        const lookup = await db.query<{ id: number }>(`SELECT id FROM apps WHERE name = $1`, [
          app_name,
        ]);
        if (lookup.rowCount === 0)
          return errorToToolResult(new AppError('not_found', `app ${app_name} not found`));
        resolved = lookup.rows[0].id;
      }
      const where = resolved !== null ? `WHERE t.app_id = $1` : '';
      const args = resolved !== null ? [resolved] : [];
      const { rows } = await db.query(
        `SELECT t.*, COALESCE(rc.role_count, 0)::int AS role_count
           FROM teams t
           LEFT JOIN (
             SELECT team_id, COUNT(*) AS role_count FROM team_roles GROUP BY team_id
           ) rc ON rc.team_id = t.id
           ${where}
           ORDER BY t.app_id NULLS FIRST, t.name ASC`,
        args,
      );
      return ok(rows);
    },
  );

  server.registerTool(
    'update_team',
    {
      description:
        'Patch any subset of team scalar fields (name, app_id, description, lead_prompt_md). Roles are managed via add_team_role / update_team_role / remove_team_role.',
      inputSchema: {
        id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        app_id: z.number().int().positive().nullable().optional(),
        description: z.string().nullable().optional(),
        lead_prompt_md: z.string().min(1).optional(),
      },
    },
    async ({ id, ...patch }) => {
      const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(
        (k) => patch[k] !== undefined,
      );
      if (fields.length === 0)
        return errorToToolResult(new AppError('invalid_input', 'no fields to update'));
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const f of fields) {
        sets.push(`${f} = $${i++}`);
        values.push(patch[f]);
      }
      sets.push(`updated_at = now()`);
      values.push(id);
      try {
        const { rows } = await db.query(
          `UPDATE teams SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (rows.length === 0)
          return errorToToolResult(new AppError('not_found', `team ${id} not found`));
        return ok(rows[0]);
      } catch (err) {
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
    },
  );

  server.registerTool(
    'delete_team',
    {
      description:
        'Hard delete a team. Cascades to team_roles and team_defaults. work_items.team_id on referencing items is set to NULL (those items revert to solo execution).',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const { rows } = await db.query(`DELETE FROM teams WHERE id = $1 RETURNING id`, [id]);
      if (rows.length === 0)
        return errorToToolResult(new AppError('not_found', `team ${id} not found`));
      return ok({ id });
    },
  );
}
