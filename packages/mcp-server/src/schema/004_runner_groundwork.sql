ALTER TABLE work_items ADD COLUMN IF NOT EXISTS attempt_count    INT NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

DROP INDEX IF EXISTS work_pending_idx;
CREATE INDEX work_pending_idx ON work_items (priority DESC, created_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS work_claim_expiry_idx ON work_items (claim_expires_at) WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS runner_config (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agent_command      TEXT NOT NULL DEFAULT 'claude --dangerously-skip-permissions -p "/sapling:work"',
  max_concurrent     INT  NOT NULL DEFAULT 1,
  poll_interval_ms   INT  NOT NULL DEFAULT 30000,
  claim_ttl_ms       INT  NOT NULL DEFAULT 7200000,
  max_claim_attempts INT  NOT NULL DEFAULT 5,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO runner_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
