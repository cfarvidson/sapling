CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  app_id         INT REFERENCES apps(id) ON DELETE CASCADE,
  description    TEXT,
  lead_prompt_md TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (app_id, name)
);

CREATE TABLE IF NOT EXISTS team_roles (
  id             SERIAL PRIMARY KEY,
  team_id        INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description_md TEXT NOT NULL,
  subagent_type  TEXT,
  ordinal        INT NOT NULL DEFAULT 0,
  UNIQUE (team_id, name)
);

CREATE TABLE IF NOT EXISTS team_defaults (
  id        SERIAL PRIMARY KEY,
  app_id    INT REFERENCES apps(id) ON DELETE CASCADE,
  work_type work_type NOT NULL,
  team_id   INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT team_defaults_uniq UNIQUE NULLS NOT DISTINCT (app_id, work_type)
);

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS work_team_idx ON work_items (team_id) WHERE team_id IS NOT NULL;
