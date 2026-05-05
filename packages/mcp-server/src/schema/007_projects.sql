CREATE TYPE project_status AS ENUM (
  'pending',
  'scoping',
  'in_progress',
  'done',
  'blocked',
  'cancelled'
);

CREATE TABLE IF NOT EXISTS projects (
  id                    SERIAL PRIMARY KEY,
  app_id                INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description_md        TEXT NOT NULL,
  definition_of_done_md TEXT NOT NULL,
  linear_url            TEXT,
  status                project_status NOT NULL DEFAULT 'pending',
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS is_dod_verifier BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS plans_project_idx
  ON plans(project_id) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_project_idx
  ON work_items(project_id) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_status_idx
  ON projects(status);
