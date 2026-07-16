# OpenClaw AWA Worker — Project Makefile
# Common commands for development, testing, and skill management.

.PHONY: dev start stop health seed test lint clean

# ─── Default target ──────────────────────────────────────────────────────────
.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Docker Compose (Production Stack) ───────────────────────────────────────

up: ## Start the full Docker stack (worker + GCS emulator)
	docker compose up -d
	@echo "  ✓ Stack started (worker: :9808, gcs: :4443)"

down: ## Stop and remove the Docker stack
	docker compose down

logs: ## Follow Docker stack logs
	docker compose logs -f

ps: ## Show Docker stack status
	docker compose ps

build: ## Rebuild the Docker worker image
	docker compose build awa-worker

create-bucket: ## Create the GCS skills bucket (first-time setup)
	@echo "Creating bucket 'awa-skills-dev'..."; \
	curl -s -X POST http://localhost:4443/storage/v1/b \
		-H "Content-Type: application/json" \
		-d '{"name":"awa-skills-dev"}' > /dev/null; \
	echo "  ✓ Bucket created"

# ─── Worker (Standalone, no Docker) ──────────────────────────────────────────

dev: ## Start worker in dev mode (hot reload, standalone)
	npm run dev

start: ## Start worker in production mode (standalone)
	npm start

stop: ## Stop the standalone worker
	@-kill $$(lsof -ti :8080 2>/dev/null) 2>/dev/null; \
	echo "  ✓ Worker stopped"

restart: stop dev ## Restart worker in dev mode

# ─── Health ──────────────────────────────────────────────────────────────────

health: ## Check worker health
	@echo "=== Worker Health ==="; \
	curl -s http://localhost:9808/healthz | python3 -m json.tool || \
	echo "  ⚠ Worker not running (start with 'make up' or 'make dev')"

# ─── GCS Emulator ────────────────────────────────────────────────────────────

.PHONY: gcs-start gcs-stop gcs-list gcs-create-bucket

gcs-start: ## Start GCS emulator (Docker, standalone)
	@docker compose up -d gcs-emulator 2>/dev/null || \
	docker compose -f .devcontainer/docker-compose.yml up -d gcs-emulator 2>/dev/null; \
	echo "  ✓ GCS emulator started on port 4443"

gcs-stop: ## Stop GCS emulator
	@docker compose stop gcs-emulator 2>/dev/null || \
	docker compose -f .devcontainer/docker-compose.yml stop gcs-emulator 2>/dev/null; \
	echo "  ✓ GCS emulator stopped"

gcs-list: ## List all objects in the skills bucket
	@echo "=== Objects in awa-skills-dev ==="; \
	curl -s "http://localhost:4443/storage/v1/b/awa-skills-dev/o" | \
	python3 -c "import sys,json; data=json.load(sys.stdin); [print('  ', o['name']) for o in data.get('items',[])]" 2>/dev/null || \
	echo "  (empty or bucket not found)"

gcs-create-bucket: ## Create the skills bucket in GCS emulator
	@echo "Creating bucket 'awa-skills-dev'..."; \
	curl -s -X POST http://localhost:4443/storage/v1/b \
		-H "Content-Type: application/json" \
		-d '{"name":"awa-skills-dev"}' > /dev/null; \
	echo "  ✓ Bucket created"

# ─── Skills ──────────────────────────────────────────────────────────────────

seed: ## Seed a skill to the GCS emulator: make seed SKILL=mrbeast.store
	@if [ -z "$(SKILL)" ]; then \
		echo "Usage: make seed SKILL=<domain>"; \
		echo "Example: make seed SKILL=mrbeast.store"; \
		exit 1; \
	fi; \
	echo "=== Seeding $(SKILL) ==="; \
	curl -s -X POST "http://localhost:4443/upload/storage/v1/b/awa-skills-dev/o?uploadType=media&name=user-scripts/$(SKILL)/manifest.json" \
		-H "Content-Type: application/json" \
		--data-binary @$(SKILL)/manifest.json > /dev/null && \
	echo "  ✓ manifest.json"; \
	curl -s -X POST "http://localhost:4443/upload/storage/v1/b/awa-skills-dev/o?uploadType=media&name=user-scripts/$(SKILL)/skill.js" \
		-H "Content-Type: application/javascript" \
		--data-binary @$(SKILL)/skill.js > /dev/null && \
	echo "  ✓ skill.js"; \
	echo "  ✅ Skill '$(SKILL)' seeded"

seed-all: ## Seed all skills from local directories (skips amazon.com — broken)
	@for dir in */manifest.json; do \
		domain=$$(basename $$(dirname $$dir)); \
		[ "$$domain" = "*" ] && continue; \
		[ "$$domain" = "amazon.com" ] && echo "  — Skipping amazon.com (broken skill)" && continue; \
		$(MAKE) seed SKILL=$$domain; \
	done

# ─── Session (requires worker running) ───────────────────────────────────────

session: ## Start a session: make session DOMAIN=mrbeast.store
	@if [ -z "$(DOMAIN)" ]; then \
		echo "Usage: make session DOMAIN=<domain>"; \
		echo "Example: make session DOMAIN=mrbeast.store"; \
		exit 1; \
	fi; \
	echo "=== Starting session for $(DOMAIN) ==="; \
	curl -s -X POST http://localhost:9808/v1/awa/session/start \
		-H "Content-Type: application/json" \
		-d "{\"domain\": \"$(DOMAIN)\"}" | python3 -m json.tool

action: ## Dispatch action to session: make action ID=<sessionId> ACTION=search PARAMS='{"query":"laptop"}'
	@if [ -z "$(ID)" ] || [ -z "$(ACTION)" ]; then \
		echo "Usage: make action ID=<sessionId> ACTION=<action> [PARAMS='{...}']"; \
		echo "Example: make action ID=sess_abc ACTION=search PARAMS='{\"query\":\"laptop\"}'"; \
		exit 1; \
	fi; \
	PARAMS_JSON="$(or $(PARAMS),{})"; \
	curl -s -X POST "http://localhost:9808/v1/awa/session/$(ID)/action" \
		-H "Content-Type: application/json" \
		-d "{\"action\": \"$(ACTION)\", \"params\": $${PARAMS_JSON}}" | python3 -m json.tool

end: ## End a session: make end ID=<sessionId>
	@if [ -z "$(ID)" ]; then \
		echo "Usage: make end ID=<sessionId>"; \
		echo "Example: make end ID=sess_abc"; \
		exit 1; \
	fi; \
	curl -s -X POST "http://localhost:9808/v1/awa/session/$(ID)/end" | python3 -m json.tool

# ─── Testing ─────────────────────────────────────────────────────────────────

test: ## Run all unit + integration tests
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-integration: ## Run integration tests only
	npm run test:integration

test-watch: ## Run tests in watch mode
	npx jest --watch

# ─── Mock Merchant ───────────────────────────────────────────────────────────

mock-start: ## Start the mock merchant site (port 3000)
	@node tests/fixtures/mock-server.js & \
	echo "  ✓ Mock merchant started on http://localhost:3000"

mock-stop: ## Stop the mock merchant
	@-kill $$(lsof -ti :3000 2>/dev/null) 2>/dev/null; \
	echo "  ✓ Mock merchant stopped"

# ─── Quality ─────────────────────────────────────────────────────────────────

lint: ## Run ESLint
	npm run lint

lint-fix: ## Auto-fix ESLint issues
	npm run lint:fix

clean: ## Remove node_modules and temp files
	rm -rf node_modules dist coverage
	rm -f /tmp/awa-*.js

# ─── Full workflow ───────────────────────────────────────────────────────────

demo: ## Run a full demo: seed → start → session → action → end
	@echo "=== Starting full demo ==="; \
	echo ""; \
	echo "➤ Step 1: Seed the skill"; \
	$(MAKE) seed SKILL=$(SKILL); \
	echo ""; \
	echo "➤ Step 2: Start worker (if not running)"; \
	curl -s http://localhost:9808/healthz > /dev/null 2>&1 || \
		($(MAKE) dev &); \
	echo ""; \
	echo "➤ Step 3: Create session"; \
	SESSION=$$(curl -s -X POST http://localhost:9808/v1/awa/session/start \
		-H "Content-Type: application/json" \
		-d "{\"domain\": \"$(SKILL)\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))"); \
	if [ -z "$$SESSION" ]; then \
		echo "  ✗ Failed to create session"; exit 1; \
	fi; \
	echo "  Session: $$SESSION"; \
	echo ""; \
	echo "➤ Step 4: Dispatch action"; \
	curl -s -X POST "http://localhost:9808/v1/awa/session/$$SESSION/action" \
		-H "Content-Type: application/json" \
		-d "{\"action\": \"$(or $(ACTION),getProduct)\", \"params\": $(or $(PARAMS),{\"sku\":\"test\",\"targetUrl\":\"http://localhost:3000/product/test\"})}" | \
		python3 -m json.tool; \
	echo ""; \
	echo "➤ Step 5: End session"; \
	curl -s -X POST "http://localhost:9808/v1/awa/session/$$SESSION/end" | \
		python3 -c "import sys,json; d=json.load(sys.stdin); print('  Closed:', d.get('status'), 'Duration:', d.get('duration'), 's')"
