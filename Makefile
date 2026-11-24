.PHONY: data dev build check docker up tiles game deploy deploy-logs

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

# --- Test server (behind the shared proxy in ~/dev/config) --------------------
HOST ?= nmaza-vultr
DEPLOY_DIR ?= /srv/dayz-atlas
TAG := $(shell git rev-parse --short HEAD)$(shell git diff --quiet HEAD || echo -dirty)

deploy: ## Build here, ship the image and tiles, restart on the server
	docker build -t dayz-atlas:$(TAG) .
	docker save dayz-atlas:$(TAG) | gzip | ssh $(HOST) 'gunzip | docker load'
	ssh $(HOST) mkdir -p $(DEPLOY_DIR)/tiles
	rsync -az deploy/compose.prod.yaml $(HOST):$(DEPLOY_DIR)/compose.yaml
	rsync -az --delete tiles/ $(HOST):$(DEPLOY_DIR)/tiles/
	ssh $(HOST) 'cd $(DEPLOY_DIR) && echo TAG=$(TAG) > .env && docker compose up -d --remove-orphans'
	ssh $(HOST) 'for i in 1 2 3 4 5 6 7 8 9 10; do docker exec edge-caddy-1 wget -qO- http://dayz-atlas:8080/health >/dev/null 2>&1 && echo "healthy: $(TAG)" && exit 0; sleep 1; done; echo "not healthy" >&2; exit 1'
	ssh $(HOST) 'docker image ls dayz-atlas --format "{{.Tag}}" | grep -vx "$(TAG)" | tail -n +3 | xargs -r -I{} docker image rm dayz-atlas:{}' || true

deploy-logs: ## Recent logs on the server
	ssh $(HOST) 'cd $(DEPLOY_DIR) && docker compose logs --tail 80'
