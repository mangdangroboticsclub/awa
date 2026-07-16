# OpenClaw AWA Worker Service

> **Agentic Web Actions (AWA)** — Multi-Tenant Runtime Engine  
> Session-based, sandboxed browser automation for merchant interaction scripts.

---

## Overview

The AWA Worker is a **session-based, multi-tenant runtime** that executes merchant interaction scripts inside hardware-enforced V8 sandboxes. OpenClaw creates a session, dispatches multiple actions (search product, add to cart, get checkout link) against a persistent browser context, then ends the session.

```
OpenClaw Brain                    AWA Worker
     │                                │
     │  POST /session/start           │
     │───────────────────────────────>│  Load skill manifest.json + skill.js
     │  { sessionId }                 │  Create V8 isolate + browser page
     │<───────────────────────────────│
     │                                │
     │  POST /session/:id/action      │
     │  { action: "getProduct" }      │
     │───────────────────────────────>│  Call handler in isolate
     │  { status, data }              │  (same browser page persists)
     │<───────────────────────────────│
     │                                │
     │  POST /session/:id/action      │
     │  { action: "addToCart" }       │
     │───────────────────────────────>│  Call handler in isolate
     │  { status, data }              │  (same browser page persists)
     │<───────────────────────────────│
     │                                │
     │  POST /session/:id/end         │
     │───────────────────────────────>│  Close context, dispose isolate
     │  { status: "closed" }          │
     │<───────────────────────────────│
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloud Run Core Worker                                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Session Manager                                          │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                │   │
│  │  │ Session #1      │  │ Session #2      │  ... (max 40)  │   │
│  │  │                 │  │                 │                │   │
│  │  │ ┌─────────────┐ │  │ ┌─────────────┐ │                │   │
│  │  │ │ V8 Isolate  │ │  │ │ V8 Isolate  │ │                │   │
│  │  │ │ (128MB cap) │ │  │ │ (128MB cap) │ │                │   │
│  │  │ │ + $awa.*    │ │  │ │ + $awa.*    │ │                │   │
│  │  │ │ + handlers  │ │  │ │ + handlers  │ │                │   │
│  │  │ └─────────────┘ │  │ └─────────────┘ │                │   │
│  │  │ ┌─────────────┐ │  │ ┌─────────────┐ │                │   │
│  │  │ │ Playwright  │ │  │ │ Playwright  │ │                │   │
│  │  │ │ Page        │ │  │ │ Page        │ │                │   │
│  │  │ └─────────────┘ │  │ └─────────────┘ │                │   │
│  │  └─────────────────┘  └─────────────────┘                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │ ScriptLoader │  │ BrowserPool  │  │ Rotating Proxy Router  ││
│  │ (GCS cache)  │  │ (Chromium)   │  │ (PROXY_MODE)           ││
│  └──────────────┘  └──────────────┘  └────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Key Principles

| Principle             | Rationale                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Defense in Depth**  | Three isolation layers: network proxy, V8 sandbox, ephemeral browser contexts            |
| **Session-Based**     | Browser persists across multiple actions within a session                                |
| **Capability-Driven** | Skills declare a manifest of URLs and capabilities (search, getProduct, addToCart, etc.) |
| **Fail-Fast**         | A single runaway action (OOM/timeout) cannot crash the host or affect other sessions     |

---

## Quick Start

### Option A: Docker Compose (Recommended)

The AWA Worker runs in a Docker container alongside a GCS emulator. Start the full stack with a single command:

```bash
# Prerequisites: Docker 24.x + Docker Compose v2.x

# 1. Start the stack (worker + GCS emulator)
docker compose up -d

# 2. Create the GCS bucket for skills (first time only)
curl -s -X POST http://localhost:4443/storage/v1/b \
  -H "Content-Type: application/json" \
  -d '{"name":"awa-skills-dev"}' > /dev/null

# 3. Verify the worker is healthy
curl http://localhost:9808/healthz
# → {"status":"healthy","activeSessions":0,"chromiumStatus":"running"}
```

### Option B: VS Code Dev Container (Development)

For an isolated development environment with full tooling:

```bash
# 1. Open the project in VS Code
code /workspace

# 2. "Reopen in Container" when prompted
#    Or F1 → "Dev Containers: Reopen in Container"
```

### Working with Skills

```bash
# Install the mpx-awa CLI globally
npm install -g ./mpx-awa

# Scaffold a new skill
mpx-awa init bestbuy.com

# Seed the skill to the GCS emulator
mpx-awa seed bestbuy.com

# Start a session
mpx-awa session start bestbuy.com

# Dispatch actions
mpx-awa session action sess_abc123 search '{"query":"laptop"}'

# End the session
mpx-awa session end sess_abc123
```

---

## API

### Session Lifecycle

| Method | Endpoint                     | Description                               |
| ------ | ---------------------------- | ----------------------------------------- |
| `POST` | `/v1/awa/session/start`      | Create a session (isolate + browser page) |
| `POST` | `/v1/awa/session/:id/action` | Dispatch an action to the session         |
| `POST` | `/v1/awa/session/:id/end`    | End the session and clean up              |
| `GET`  | `/v1/awa/session/:id`        | Get session status                        |
| `GET`  | `/healthz`                   | Worker health check                       |

### Example: Full Session

```bash
# 1. Start a session
SESSION=$(curl -s -X POST http://localhost:9808/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "mrbeast.store"}' | jq -r '.sessionId')

# 2. Get product details
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "getProduct", "params": {"sku": "test123"}}'

# 3. End the session
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/end"
```

See [API.md](docs/API.md) for the full specification.

---

## Skill Scripts

Skills are stored in GCS and consist of two files:

```
gs://awa-skills-prod/user-scripts/bestbuy.com/
├── manifest.json       ← Domain, capabilities, URL patterns
└── skill.js            ← Handler implementations
```

Use the [AWA SDK CLI](mpx-awa/) to scaffold new skills:

```bash
npx mpx-awa init bestbuy.com
# Creates: bestbuy.com/{manifest.json, skill.js, GUIDE.md}
```

---

## Makefile (Project Automation)

A `Makefile` at the project root automates common development tasks.

```bash
make help           # List all targets
```

### Docker Compose (Production Stack)

```bash
make up             # Start the full stack (worker + GCS emulator)
make down           # Stop and remove the stack
make logs           # Follow logs
make ps             # Show container status
make build          # Rebuild the worker image
make create-bucket  # Create GCS skills bucket (first-time setup)
```

### Worker (Standalone, no Docker)

```bash
make dev            # Start worker with hot reload
make start          # Start worker (production mode)
make stop           # Stop the worker
make restart        # Restart in dev mode
make health         # Check worker health
```

### GCS Emulator

```bash
make gcs-start      # Start GCS emulator (Docker)
make gcs-stop       # Stop GCS emulator
make gcs-list       # List objects in skills bucket
make gcs-create-bucket  # Create the skills bucket
```

### Skills

```bash
make seed SKILL=mrbeast.store   # Seed a skill to GCS emulator
make seed-all                   # Seed all skills from local directories
```

### Sessions

```bash
make session DOMAIN=mrbeast.store    # Start a new session
make action ID=sess_abc ACTION=search PARAMS='{"query":"laptop"}'  # Dispatch
make end ID=sess_abc                 # End a session
```

### Mock Merchant

```bash
make mock-start     # Start mock site on port 3000
make mock-stop      # Stop mock site
```

### Testing

```bash
make test           # Run all tests
make test-unit      # Unit tests only
make test-integration  # Integration tests only
make lint           # ESLint check
```

### Full Demo

```bash
make demo SKILL=mrbeast.store ACTION=search PARAMS='{"query":"laptop"}'
# Seeds → starts worker → creates session → dispatches action → ends
```

---

## AWA SDK CLI

The [mpx-awa CLI](mpx-awa/) provides additional commands beyond scaffolding:

```bash
# Seed a skill to the GCS emulator
mpx-awa seed mrbeast.store

# Session management (worker must be running)
mpx-awa session start mrbeast.store
mpx-awa session list
mpx-awa session get sess_abc123
mpx-awa session action sess_abc123 search '{"query":"laptop"}'
mpx-awa session end sess_abc123
```

Environment variables:

| Variable           | Default                    | Description                       |
| ------------------ | -------------------------- | --------------------------------- |
| `AWA_WORKER_URL`   | `http://localhost:9808`    | Worker URL for session commands   |
| `GCS_EMULATOR_URL` | `http://localhost:4443`    | GCS emulator URL for seed command |

---

## Project Structure

```
workspace/
├── .devcontainer/          # Dev container (Docker, Compose, seccomp)
├── docs/                   # Architecture, API, SDD, Security, Deployment
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── SDD.md
│   ├── DEPLOYMENT.md
│   ├── SECURITY.md
│   └── guides/
├── mpx-awa/                # AWA SDK CLI (npm installable)
│   ├── bin/mpx-awa.js      # CLI entry point
│   ├── src/commands/       # init command
│   └── templates/          # skill.js, manifest.json, GUIDE.md
├── src/
│   ├── server.js           # Express entry point
│   ├── routes/awa.js       # Session endpoints
│   ├── middleware/          # auth, rate-limit, validation
│   ├── services/
│   │   ├── session-manager.js   # Session lifecycle + idle sweeper
│   │   ├── isolate-pool.js      # V8 isolate pool + handler dispatch
│   │   ├── browser-pool.js      # Playwright context pool
│   │   ├── script-loader.js     # GCS fetcher + LRU cache
│   │   ├── script-screener.js   # AST-based security screener
│   │   └── proxy-router.js      # Rotating proxy config
│   └── utils/
│       ├── logger.js        # Structured JSON logger
│       └── errors.js        # Error classes
├── tests/
│   ├── unit/               # 9 test suites (73 tests)
│   ├── integration/        # 1 test suite (9 tests)
│   └── fixtures/           # Mock merchant site, sample scripts
├── scripts/
│   ├── seed-scripts.js     # Upload fixtures to GCS emulator
│   └── benchmark.js        # Load testing tool
├── .env.example
├── jest.config.js
└── package.json
```

---

## Configuration

Key environment variables (see `.env.example` for all):

| Variable                  | Default           | Description                                |
| ------------------------- | ----------------- | ------------------------------------------ |
| `PORT`                    | `8080`            | HTTP server port                           |
| `NODE_ENV`                | `development`     | Runtime mode                               |
| `GCS_ENDPOINT`            | —                 | GCS emulator endpoint (set for local dev)  |
| `GCS_BUCKET`              | `awa-skills-dev`  | Skills bucket name                         |
| `ISOLATE_MEMORY_LIMIT_MB` | `128`             | Per-isolate memory cap                     |
| `ISOLATE_TIMEOUT_MS`      | `30000`           | Per-action timeout                         |
| `ISOLATE_POOL_SIZE`       | `20`              | Pre-warmed isolate count                   |
| `BROWSER_POOL_SIZE`       | `40`              | Max concurrent sessions                    |
| `PROXY_MODE`              | `none`            | `"none"` for dev, `"residential"` for prod |
| `SESSION_IDLE_TIMEOUT_MS` | `900000` (15 min) | Session idle timeout                       |
| `LOG_LEVEL`               | `info`            | Logging verbosity                          |

---

## Testing

```bash
npm test                  # Unit + integration tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests (needs GCS emulator)
npm run test:e2e          # E2E tests (needs RUN_E2E=true)
npm run lint              # ESLint check
```

Current status: **104 tests passing** (11 suites, 4 E2E conditional).

---

## Deployment

See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full GCP deployment guide.

```bash
# Build the container
docker build -t awa-worker:latest .

# Deploy to Cloud Run
gcloud run deploy awa-worker \
  --image=us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest \
  --region=us-central1 --memory=2Gi --cpu=2 --concurrency=40 --timeout=60
```

---

## License

MIT — OpenClaw
