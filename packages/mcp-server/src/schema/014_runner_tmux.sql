ALTER TABLE runner_config
  ADD COLUMN IF NOT EXISTS use_tmux          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tmux_session_name TEXT    NOT NULL DEFAULT 'sapling';
