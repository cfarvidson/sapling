ALTER TABLE runner_config ALTER COLUMN max_concurrent SET DEFAULT 2;
UPDATE runner_config SET max_concurrent = 2, updated_at = now() WHERE id = 1 AND max_concurrent = 1;
