.PHONY: up down logs psql test nuke build runner

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f mcp-server

psql:
	docker compose exec postgres psql -U $${POSTGRES_USER:-sapling} -d $${POSTGRES_DB:-sapling}

build:
	docker compose build

test:
	pnpm --filter mcp-server test
	pnpm --filter sapling-runner test

runner:
	pnpm --filter sapling-runner dev

nuke:
	@echo "This will delete ./data/postgres. Press Ctrl-C to cancel."
	@sleep 5
	docker compose down -v
	rm -rf data/postgres
