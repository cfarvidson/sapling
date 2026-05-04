-- Native review→fix chaining: a work item can declare a single upstream dep.
-- claim_next_work skips items whose dep isn't 'completed' (filtered at query time;
-- no new status, no triggers). ON DELETE SET NULL so deleting an upstream item
-- does not orphan dependents (they become claimable again, mirroring the FK
-- convention used elsewhere).

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS depends_on_work_id INT
    REFERENCES work_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS work_depends_on_idx
  ON work_items (depends_on_work_id)
  WHERE depends_on_work_id IS NOT NULL;
