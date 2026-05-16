.PHONY: up down logs psql test nuke build runner tui

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f mcp-server

psql:
	docker compose exec -T postgres psql -U $${POSTGRES_USER:-sapling} -d $${POSTGRES_DB:-sapling}

build:
	docker compose build

test:
	pnpm --filter mcp-server test
	pnpm --filter sapling-runner test

runner:
	SAPLING_RUNNER_LOG_FILE=$(CURDIR)/data/runner.log pnpm --filter sapling-runner dev

# Boot a tmux session named "sapling" with the runner in one window and the
# TUI in another, then attach. The runner detects $TMUX at startup and uses
# the tmux spawner automatically, so each agent gets its own window. Re-running
# `make tui` while the session already exists just re-attaches.
tui:
	@command -v tmux >/dev/null 2>&1 || { echo "tmux is required for 'make tui' — install it or use 'make runner' instead"; exit 1; }
	@tmux has-session -t sapling 2>/dev/null || \
		tmux new-session -d -s sapling -n runner \
			"SAPLING_RUNNER_LOG_FILE=$(CURDIR)/data/runner.log pnpm --filter sapling-runner dev"
	@tmux list-windows -t sapling -F '#{window_name}' | grep -qx tui || \
		tmux new-window -t sapling -n tui "pnpm --filter sapling-tui dev"
	@tmux select-window -t sapling:tui
	@tmux attach -t sapling

nuke:
	@echo "This will delete ./data/postgres. Press Ctrl-C to cancel."
	@sleep 5
	docker compose down -v
	rm -rf data/postgres
