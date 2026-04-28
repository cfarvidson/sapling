-- Sapling initial schema

-- Apps & services
CREATE TABLE apps (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id           SERIAL PRIMARY KEY,
  app_id       INT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  repo_url     TEXT,
  description  TEXT,
  tech_stack   TEXT[] NOT NULL DEFAULT '{}',
  depends_on   TEXT[] NOT NULL DEFAULT '{}',
  conventions  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

-- Plans
CREATE TYPE plan_status AS ENUM ('draft','active','completed','archived');

CREATE TABLE plans (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  status          plan_status NOT NULL DEFAULT 'draft',
  service_id      INT REFERENCES services(id) ON DELETE SET NULL,
  parent_plan_id  INT REFERENCES plans(id)    ON DELETE SET NULL,
  body_markdown   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plans_service_idx ON plans(service_id);
CREATE INDEX plans_status_idx  ON plans(status);

-- Work queue
CREATE TYPE work_type   AS ENUM ('plan','code','review');
CREATE TYPE work_status AS ENUM ('pending','claimed','completed','failed','cancelled');

CREATE TABLE work_items (
  id                   SERIAL PRIMARY KEY,
  type                 work_type   NOT NULL,
  status               work_status NOT NULL DEFAULT 'pending',
  title                TEXT NOT NULL,
  description_markdown TEXT NOT NULL,
  priority             INT  NOT NULL DEFAULT 0,
  service_id           INT  REFERENCES services(id) ON DELETE SET NULL,
  plan_id              INT  REFERENCES plans(id)    ON DELETE SET NULL,
  branch               TEXT,
  pr_url               TEXT,
  claimed_at           TIMESTAMPTZ,
  claimed_by           TEXT,
  completed_at         TIMESTAMPTZ,
  failure_reason       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_pending_idx ON work_items(priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX work_status_idx  ON work_items(status);

-- Artifacts
CREATE TABLE artifacts (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  work_item_id  INT REFERENCES work_items(id) ON DELETE SET NULL,
  plan_id       INT REFERENCES plans(id)      ON DELETE SET NULL,
  service_id    INT REFERENCES services(id)   ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_work_idx ON artifacts(work_item_id);
CREATE INDEX artifacts_plan_idx ON artifacts(plan_id);
