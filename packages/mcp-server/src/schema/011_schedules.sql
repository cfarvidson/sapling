CREATE TYPE schedule_source AS ENUM ('app', 'github_org');
CREATE TYPE schedule_overlap AS ENUM ('skip_if_running', 'always_fire');
CREATE TYPE schedule_run_status AS ENUM ('fired', 'skipped_overlap', 'failed');

CREATE TABLE IF NOT EXISTS schedules (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL UNIQUE,
  source_type              schedule_source NOT NULL,
  app_id                   INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_org               TEXT,
  cron_expr                TEXT NOT NULL,
  timezone                 TEXT NOT NULL DEFAULT 'UTC',
  overlap_policy           schedule_overlap NOT NULL DEFAULT 'skip_if_running',
  title_template           TEXT NOT NULL,
  description_md           TEXT NOT NULL,
  definition_of_done_md    TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at            TIMESTAMPTZ,
  next_run_at              TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_type = 'app'        AND github_org IS NULL)
    OR (source_type = 'github_org' AND github_org IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules(next_run_at) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id            SERIAL PRIMARY KEY,
  schedule_id   INT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        schedule_run_status NOT NULL,
  project_id    INT REFERENCES projects(id) ON DELETE SET NULL,
  error         TEXT,
  duration_ms   INT
);

CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx
  ON schedule_runs(schedule_id, fired_at DESC);

ALTER TABLE runner_config
  ADD COLUMN IF NOT EXISTS github_token              TEXT,
  ADD COLUMN IF NOT EXISTS github_default_visibility TEXT NOT NULL DEFAULT 'all';
