.PHONY: up down logs psql test nuke build

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

nuke:
	@echo "This will delete ./data/postgres. Press Ctrl-C to cancel."
	@sleep 5
	docker compose down -v
	rm -rf data/postgres
