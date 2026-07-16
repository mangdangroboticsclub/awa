# Development Guide — OpenClaw AWA Worker Service

> **Version:** 2.0.0  
> **Status:** DRAFT  

---

## 1. Architecture Overview

The AWA Worker is a **session-based, multi-tenant runtime** for executing merchant interaction scripts. Each session pairs a hardware-enforced V8 isolate with a persistent Playwright browser context. OpenClaw dispatches multiple actions (search, getProduct, addToCart, getCheckoutLink) within a single session.

```
Cloud Run Instance
├── Chromium Process (single)
│   ├── BrowserContext #1 (Session A) ── Isolate #1 ── Skill: siteA.domain
│   ├── BrowserContext #2 (Session B) ── Isolate #2 ── Skill: siteB.domain
│   └── ... (up to 40 sessions)
│
├── Express HTTP Server
│   └── Router
│       ├── POST /v1/awa/session/start
│       ├── POST /v1/awa/session/:id/action
│       ├── POST /v1/awa/session/:id/end
│       ├── GET  /v1/awa/session/:id
│       ├── POST /v1/awa/execute        (legacy)
│       └── GET  /healthz
│
└── Session Manager
    ├── Session #1: { isolate, context, page, skill, createdAt }
    ├── Session #2: { isolate, context, page, skill, createdAt }
    └── ... (up to 40)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full component diagram.

---

## 2. Quick Start (Docker Compose)

The recommended way to run the AWA Worker locally is via Docker Compose. This starts the worker alongside a `fake-gcs-server` emulator — no GCP account required.

### 2.1 Prerequisites

| Tool               | Minimum Version | Purpose                                   |
| ------------------ | --------------- | ----------------------------------------- |
| **Docker**         | 24.x            | Container runtime                         |
| **Docker Compose** | v2.x            | Multi-container orchestration             |
| **Node.js**        | 20.x            | Runtime (only needed for CLI / tests)     |
| **npm**            | 9.x             | Package management                        |

### 2.2 Start the Stack

```bash
# 1. Start the worker + GCS emulator
docker compose up -d

# 2. Create the GCS bucket (first time only)
curl -s -X POST http://localhost:4443/storage/v1/b \
  -H "Content-Type: application/json" \
  -d '{"name":"awa-skills-dev"}' > /dev/null

# 3. Verify the worker is healthy
curl http://localhost:9808/healthz
# → {"status":"healthy","activeSessions":0,"chromiumStatus":"running"}

# 4. Install the CLI globally
npm install -g ./mpx-awa

# 5. Scaffold and seed a skill
mpx-awa init mrbeast.store
mpx-awa seed mrbeast.store

# 6. Start a session
mpx-awa session start mrbeast.store
```

> **Note:** The worker listens on port **8080 internally**, mapped to **9808 on the host**.
> The CLI (`mpx-awa session`) defaults to port 9808 automatically.

### 2.3 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Docker Network                          │
│                                                              │
│  ┌──────────────────────┐      ┌──────────────────────────┐  │
│  │ awa-worker           │      │ awa-gcs-emulator         │  │
│  │ (Node 20 + Chromium) │      │ (fake-gcs-server)        │  │
│  │                      │      │                          │  │
│  │  :8080               │◄─────│  :4443                   │  │
│  │  (host :9808)        │      │  (host :4443)            │  │
│  └──────────────────────┘      └──────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Host (mpx-awa CLI)                                       ││
│  │                                                          ││
│  │  mpx-awa seed mrbeast.store    → localhost:4443          ││
│  │  mpx-awa session start beast   → localhost:9808           ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### 2.4 Makefile Shortcuts

A `Makefile` at the project root provides convenient wrappers:

```bash
make up             # docker compose up -d
make down           # docker compose down
make logs           # docker compose logs -f
make health         # curl http://localhost:9808/healthz
make build          # Rebuild worker image
make create-bucket  # Create GCS skills bucket
make seed SKILL=mrbeast.store   # Seed a skill to GCS
make seed-all                   # Seed all local skills
make session DOMAIN=mrbeast.store  # Start a session
make test           # Unit + integration tests
make demo SKILL=mrbeast.store   # Full end-to-end demo
```

---

## 3. VS Code Dev Container (Alternative)

For a fully isolated development environment with additional tooling (gcloud CLI, jq, ripgrep), use the **VS Code Dev Container**.

### 3.1 Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Docker | >= 24.x | Container runtime |
| VS Code | Latest | Editor with Dev Containers extension |
| Dev Containers ext. | Latest | `ms-vscode-remote.remote-containers` |

### 3.2 Quick Start

```bash
# 1. Open the project in VS Code
code /path/to/mpx-cloud-sdk

# 2. When prompted "Reopen in Container?", click it
#    Or F1 → "Dev Containers: Reopen in Container"
```

### 3.3 What's Included

| Component | Purpose |
|---|---|
| **Node.js 20 + npm** | Runtime and package management |
| **Chromium (bundled)** | Playwright's bundled browser (reliable in Docker) |
| **Playwright + StealthPlugin** | Browser automation with anti-detection |
| **isolated-vm build tools** | Python3, make, g++ for native addon compilation |
| **Google Cloud SDK** | `gcloud` CLI for GCS interaction |
| **GCS Emulator (sidecar)** | `fake-gcs-server` backed by a shared Docker volume |
| **Dev utilities** | git, curl, jq, ripgrep |

### 3.4 Key Differences: Dev Container vs. Docker Compose

| Aspect | Dev Container | Docker Compose |
|---|---|---|
| **Purpose** | Full development & debugging | Production-like testing |
| **Hot reload** | Yes (`npm run dev`) | No (rebuild to update) |
| **gcloud CLI** | Included | Not included |
| **VS Code** | Required | Not required |
| **Build speed** | Slower (more deps) | Faster (slim image) |

---

## 4. Manual Setup (Standalone)

For running the worker outside Docker (useful for quick iteration or debugging).

### 4.1 Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 20.x | Runtime |
| npm | >= 9.x | Package management |
| Docker | >= 24.x | GCS emulator only |
| Chromium | System or bundled | Headless browser for Playwright |

### 4.2 Install System Dependencies (Linux)

```bash
# Playwright + Chromium dependencies
sudo apt-get update && sudo apt-get install -y \
  wget gnupg ca-certificates procps \
  libgconf-2-4 libatk1.0-0 libatk-bridge2.0-0 \
  libgdk-pixbuf2.0-0 libgtk-3-0 libgbm1 \
  libnss3 libxss1 libasound2
```

### 4.3 Install Node.js

```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

### 4.4 Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd mpx-cloud-sdk
npm install
cp .env.example .env

# 2. Start GCS emulator (Docker)
docker compose up -d gcs-emulator

# 3. Start worker with hot reload
npm run dev
# Starts on http://localhost:8080
```

### 4.5 Environment Variables

```bash
# Server
PORT=8080
NODE_ENV=development

# GCS Emulator
GCS_ENDPOINT=http://localhost:4443
GCS_BUCKET=awa-skills-dev
GCS_PROJECT_ID=openclaw-dev

# Isolate Sandbox
ISOLATE_MEMORY_LIMIT_MB=128
ISOLATE_TIMEOUT_MS=30000
ISOLATE_POOL_SIZE=5           # Smaller pool for local dev

# Browser Pool
BROWSER_POOL_SIZE=10           # Smaller pool for local dev

# Proxy (bypassed locally)
PROXY_MODE=none
PROXY_PROVIDER_URL=
PROXY_API_KEY=

# Rate Limiting (relaxed locally)
RATE_LIMIT_DOMAIN=100
RATE_LIMIT_GLOBAL=5000

# Logging
LOG_LEVEL=debug
```

---

## 5. Project Structure

```
mpx-cloud-sdk/
├── .devcontainer/                # Dev container configuration
│   ├── devcontainer.json         # VS Code Dev Container config
│   ├── Dockerfile                # Dev container image
│   ├── docker-compose.yml        # Dev container stack
│   ├── post-create.sh            # One-time setup script
│   └── seccomp-default.json      # Seccomp profile for Chromium
├── docs/
│   ├── SDD.md                    # Software Design Document
│   ├── ARCHITECTURE.md           # Architecture overview
│   ├── API.md                    # API specification
│   ├── DEVELOPMENT.md            # This file
│   ├── DEPLOYMENT.md             # Deployment guide
│   ├── SECURITY.md               # Security model
│   └── guides/
│       └── LOCAL_AWA_SETUP.md    # Local dev setup guide
├── mpx-awa/                      # AWA SDK CLI
│   ├── bin/mpx-awa.js            # CLI entry point
│   ├── src/commands/             # init, seed, session
│   └── templates/                # skill.js, manifest.json, GUIDE.md
├── mrbeast.store/                # Working Shopify skill (example)
│   ├── manifest.json
│   ├── skill.js
│   └── GUIDE.md
├── src/
│   ├── server.js                 # Express entry point
│   ├── routes/
│   │   └── awa.js                # Session & legacy endpoints
│   ├── services/
│   │   ├── session-manager.js    # Session lifecycle + idle sweeper
│   │   ├── isolate-pool.js       # V8 isolate pool + handler dispatch
│   │   ├── browser-pool.js       # Playwright context pool
│   │   ├── script-loader.js      # GCS fetcher + LRU cache
│   │   ├── script-screener.js    # AST-based security screener
│   │   └── proxy-router.js       # Rotating proxy config
│   ├── middleware/
│   │   ├── auth.js               # Service account token validation
│   │   ├── rate-limit.js         # Rate limiting middleware
│   │   └── validation.js         # Request schema validation
│   └── utils/
│       ├── logger.js             # Structured JSON logger
│       └── errors.js             # Error classes & mapping
├── tests/
│   ├── unit/                     # 9 suites (unit tests)
│   ├── integration/              # Integration tests
│   ├── e2e/                      # End-to-end tests (conditional)
│   └── fixtures/
│       ├── scripts/bestbuy.js    # Sample skill script
│       └── mock-server.js        # Mock merchant site
├── scripts/
│   ├── seed-scripts.js           # Upload fixtures to GCS
│   └── benchmark.js              # Load testing
├── data/gcs/                     # GCS emulator data (git-ignored)
├── docker-compose.yml            # Production stack (worker + GCS)
├── Dockerfile                    # Multi-stage production image
├── Makefile                      # Project automation
├── jest.config.js                # Jest configuration
├── package.json
├── .env.example
└── .env                          # Local environment (git-ignored)
```

---

## 6. Running Tests

### 6.1 Unit Tests

```bash
# Run all unit tests
npm run test:unit

# Run with coverage
npm run test:unit -- --coverage

# Run a specific test file
npx jest tests/unit/isolate-pool.test.js
```

### 6.2 Integration Tests

```bash
# Requires: gcs-emulator running, .env configured
npm run test:integration

# Run with verbose output
npm run test:integration -- --verbose
```

### 6.3 End-to-End Tests

```bash
# Requires: full Docker stack running, RUN_E2E=true
npm run test:e2e
```

### 6.4 Test Fixtures

Sample merchant scripts are in `tests/fixtures/scripts/`. The mock merchant site runs on port 3000:

```bash
make mock-start       # Start mock site on port 3000
make mock-stop        # Stop mock site
```

---

## 7. Working with Sessions

### 7.1 Start a Session

```bash
# Using curl
curl -s -X POST http://localhost:9808/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "mrbeast.store"}'

# Response
{"sessionId":"sess_abc123","status":"ready","domain":"mrbeast.store",...}
```

### 7.2 Dispatch an Action

```bash
curl -s -X POST http://localhost:9808/v1/awa/session/sess_abc123/action \
  -H "Content-Type: application/json" \
  -d '{"action": "getProduct", "params": {"sku": "test123"}}'
```

### 7.3 End a Session

```bash
curl -s -X POST http://localhost:9808/v1/awa/session/sess_abc123/end

# Response
{"status":"closed","sessionId":"sess_abc123","duration":42}
```

### 7.4 Full Session Lifecycle (cURL)

```bash
# 1. Start
SESSION=$(curl -s -X POST http://localhost:9808/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "mrbeast.store"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")

# 2. Dispatch
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "getProduct", "params": {"sku": "test"}}'

# 3. End
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/end"
```

### 7.5 Using Makefile

```bash
make session DOMAIN=mrbeast.store      # Start a session
make action ID=sess_abc ACTION=getProduct  # Dispatch action
make end ID=sess_abc                       # End session
make demo SKILL=mrbeast.store              # Full workflow
```

---

## 8. Debugging

### 8.1 Debug Logs

Set `LOG_LEVEL=debug` in `.env` for verbose logging:

```json
{"level":"debug","msg":"Creating new V8 isolate","sessionId":"abc123"}
{"level":"debug","msg":"Fetching manifest from GCS","domain":"mrbeast.store"}
{"level":"debug","msg":"Navigating to target URL","url":"https://...","sessionId":"abc123"}
{"level":"info","msg":"Action completed","status":"success","duration":1234,"sessionId":"abc123"}
```

### 8.2 Chromium Debugging

To see what Playwright is doing, enable headed mode:

```bash
# In .env
PLAYWRIGHT_HEADLESS=false
```

Then execute a request — the Chromium window will be visible. On Linux with X11, this works out of the box.

### 8.3 V8 Isolate Inspection

The `isolated-vm` module can enable the V8 inspector for debugging:

```javascript
// In src/services/isolate-pool.js
const isolate = new ivm.Isolate({
  memoryLimit: 128,
  inspector: true,  // Enable V8 inspector (disabled in production)
});
```

### 8.4 Common Issues

| Issue | Symptom | Fix |
|---|---|---|
| Chromium not found | `Error: Failed to launch browser` | Use bundled Chromium (`npx playwright install chromium`) |
| GCS connection refused | `Connection refused: localhost:4443` | Start GCS emulator: `docker compose up -d gcs-emulator` |
| Skill not found | `"SkillNotFound"` | Ensure `data/gcs/awa-skills-dev/user-scripts/<domain>/` has `manifest.json` and `skill.js` |
| Invalid manifest JSON | `"SkillNotFound"` | Check `manifest.json` for syntax errors — JSON does not allow comments |
| Isolate OOM | `"Execution memory threshold exceeded."` | Reduce script complexity or increase `ISOLATE_MEMORY_LIMIT_MB` |
| Proxy auth failure | `403 Forbidden` on egress | Set `PROXY_MODE=none` for local dev |
| In-Docker curl fails | `Could not resolve host` | Use `localhost` not `gcs-emulator` when curling from the host |

---

## 9. Code Style & Conventions

### 9.1 Linting

```bash
# Check code style
npm run lint

# Auto-fix
npm run lint -- --fix
```

### 9.2 Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(awa): add script caching layer
fix(isolate): handle OOM without crashing host
docs(api): document rate limit headers
chore(deps): update playwright to 1.40.0
```

### 9.3 Pre-commit Hooks

```bash
npm run prepare  # Installs husky hooks
# Pre-commit runs: lint → test:unit → build
```

---

## 10. Service Account Authentication (Local Dev)

For local testing with GCS:

```bash
# Use application default credentials
gcloud auth application-default login

# Or set a service account key
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

---

## 11. Useful Commands Reference

```bash
npm run dev          # Start dev server with hot reload
npm run build        # Compile TypeScript
npm start            # Start production server
npm test             # Run all tests
npm run test:unit    # Unit tests
npm run test:integration  # Integration tests (needs emulator)
npm run lint         # Lint check
npm run lint:fix     # Lint auto-fix
npm run seed         # Upload seed scripts to GCS emulator
npm run benchmark    # Run load tests
npm run clean        # Remove dist/ and node_modules
```
