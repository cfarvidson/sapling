ALTER TABLE runner_config
  ADD COLUMN IF NOT EXISTS ntfy_url                     TEXT,
  ADD COLUMN IF NOT EXISTS awaiting_input_nag_age_ms    INT  NOT NULL DEFAULT 3600000,
  ADD COLUMN IF NOT EXISTS awaiting_input_nag_repeat_ms INT  NOT NULL DEFAULT 21600000;
