.PHONY: data dev build check docker up tiles game

data: ## Regenerate tiles and JSON layers into web/public/data
	python3 scripts/build_data.py

dev: ## Vite dev server
	cd web && pnpm install && pnpm dev

check: ## Typecheck + lint
	cd web && pnpm typecheck && pnpm lint

build: ## Production build into web/dist
	cd web && pnpm build

docker: ## Build the container image
	docker compose build

up: ## Run the container (http://localhost:8080)
	docker compose up -d

tiles: ## High-res tiles into ./tiles: make tiles MAP=chernarus IMAGE=satellite.tif
	python3 scripts/make_tiles.py $(MAP) $(IMAGE)

game: ## High-res satellite + place names from your DayZ install into ./tiles (needs uv)
	uv run scripts/extract_game.py chernarus
	uv run scripts/extract_game.py livonia
