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
            [teamId, role.name, role.description_md, role.subagent_type ?? null, role.ordinal ?? 0],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        return errorToToolResult(mapPgError(err as { code?: string; message?: string }));
      }
      client.release();
      const full = await loadTeamWithRoles(db, teamId);
      return ok(full);
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
}
