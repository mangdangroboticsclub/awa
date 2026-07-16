# Local AWA Development Setup — GCP-Migratable Solution

> **Version:** 1.0.0  
> **Status:** DRAFT  
> **Supersedes:** Portions of `DEVELOPMENT.md` (local environment)  
> **See Also:** `SDD.md`, `ARCHITECTURE.md`, `DEPLOYMENT.md`, `DEVELOPMENT.md`

---

## 1. Overview

This guide describes how to run the **OpenClaw Agentic Web Actions (AWA) Worker Service** entirely on your local machine — without any Google Cloud Platform dependencies — while keeping the architecture close enough to production that migration is straightforward.

The key idea is to **emulate every GCP service** that the Cloud Run worker depends on, using lightweight local substitutes. This lets you:

- Develop and test merchant skill scripts offline.
- Run the full request lifecycle (HTTP → isolate → Playwright → response) locally.
- Validate sandbox behavior, memory limits, and timeouts.
- Switch to real GCP services by changing only configuration — no code changes needed.

---

## 2. Architecture: Local vs. GCP

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      LOCAL (Docker Compose)                                  │
│                                                                                             │
│  ┌─────────────────────────────────┐       ┌────────────────────────────────────────────┐   │
│  │  awa-worker-dev                 │       │  awa-gcs-emulator                          │   │
│  │  (Node.js 20 + Chromium)        │       │  (fake-gcs-server)                         │   │
│  │                                 │       │                                            │   │
│  │  ┌───────────────────────────┐  │       │  • Port 4443                              │   │
│  │  │ Express Server (:8080)    │  │       │  • File-system backed                      │   │
│  │  POST /v1/awa/session/*   │  │       │  • Bucket: awa-skills-dev                 │  │
│  │  GET  /healthz            │  │       │    └── user-scripts/<domain>/              │  │
│  │                           │  │       │        ├── manifest.json                  │  │
│  │  (host :9808)             │  │       │        └── skill.js                      │  │
│  │  └───────────────────────────┘  │       └────────────────────────────────────────────┘   │
│  │         │                       │                                                         │
│  │  ┌──────▼──────────┐           │                                                         │
│  │  │ Script Loader    │──HTTP────┘                                                         │
│  │  │ (GCS client)     │     (GCS_ENDPOINT=http://gcs-emulator:4443)                        │
│  │  └──────────────────┘                                                                     │
│  │         │                                                                                 │
│  │  ┌──────▼──────────┐                                                                     │
│  │  │ Isolate Pool     │  isolated-vm (128MB cap, 30s timeout)                              │
│  │  │  └→ V8 Isolate   │                                                                     │
│  │  │     └→ Playwright Page ──► Merchant Site (no proxy)                                   │
│  │  └──────────────────┘                                                                     │
│  └─────────────────────────────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

                                      ▲  Drop-in migration  ▼

┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      GCP (Cloud Run)                                        │
│                                                                                             │
│  ┌─────────────────────────────────┐       ┌────────────────────────────────────────────┐   │
│  │  Cloud Run Core Worker          │       │  Cloud Storage (Skills Bucket)             │   │
│  │                                 │       │                                            │   │
│  │  • Same Express app             │       │  • gs://awa-skills-prod                    │   │
│  │  • Port 8080                    │       │  • IAM-protected                           │   │
│  │  • Managed by Cloud Run         │       │  • Accessed via gcloud SDK                 │   │
│  └─────────────────────────────────┘       └────────────────────────────────────────────┘   │
│         │                                                                                    │
│  ┌──────▼──────────┐                                                                        │
│  │ Script Loader    │──gcloud SDK──► Cloud Storage                                           │
│  │ (GCS client)     │  (GCS_ENDPOINT unset → real GCS)                                      │
│  └──────────────────┘                                                                        │
│         │                                                                                    │
│  ┌──────▼──────────┐                                                                        │
│  │ Isolate Pool     │  Same isolated-vm config                                               │
│  │  └→ V8 Isolate   │                                                                       │
│  │     └→ Playwright Page ──► Rotating Proxy ──► Merchant Site                              │
│  └──────────────────┘                                                                        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Service Mapping

| GCP Service                   | Local Equivalent                     | Purpose                                |
| ----------------------------- | ------------------------------------ | -------------------------------------- |
| **Cloud Run**                 | Docker container (Node.js 20)        | Hosts the Express worker               |
| **Cloud Storage**             | `fake-gcs-server`                    | Stores & serves merchant skill scripts |
| **Cloud NAT / VPC Connector** | Direct egress (or `PROXY_MODE=none`) | Network routing (bypassed locally)     |
| **Secret Manager**            | `.env` file or plaintext env vars    | Secrets management                     |
| **Cloud Load Balancer**       | `localhost:8080`                     | HTTP ingress                           |
| **Cloud IAM**                 | None (trusted internal network)      | Auth / access control                  |
| **Artifact Registry**         | Local Docker image                   | Container image storage                |
| **Rotating Proxy**            | Skipped (set `PROXY_MODE=none`)      | Egress IP rotation / anti-bot          |

---

## 3. Prerequisites

| Tool               | Minimum Version | Purpose                                   |
| ------------------ | --------------- | ----------------------------------------- |
| **Docker**         | 24.x            | Container runtime for the dev environment |
| **Docker Compose** | v2.x            | Multi-container orchestration             |
| **VS Code**        | Latest          | Recommended editor (with Dev Containers)  |
| **Git**            | Any             | Source control                            |

> **No Google Cloud SDK** is required for local development. The `fake-gcs-server` emulator speaks the same HTTP API as real GCS, so the worker's GCS client library works unchanged.

---

## 4. Directory Structure

```
mpx-cloud-sdk/
├── .devcontainer/                    # Dev container configuration (VS Code)
│   ├── devcontainer.json             # VS Code Dev Container definition
│   ├── Dockerfile                    # Dev container image (Node 20 + Chromium)
│   ├── docker-compose.yml            # Multi-container stack
│   ├── post-create.sh                # One-time setup (npm install, seed dirs)
│   └── seccomp-default.json          # Seccomp profile for Chromium in Docker
├── docs/
│   ├── guides/
│   │   └── LOCAL_AWA_SETUP.md        # ← This file
│   ├── API.md
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   ├── DEVELOPMENT.md
│   ├── SDD.md
│   └── SECURITY.md
├── src/                              # Worker source code
│   ├── server.js                     # Express entry point
│   ├── routes/awa.js                 # /v1/awa/execute handler
│   ├── services/
│   │   ├── isolate-pool.js           # isolated-vm pool manager
│   │   ├── script-loader.js          # GCS script fetcher + cache
│   │   ├── browser-pool.js           # Playwright context pool
│   │   └── proxy-router.js           # Proxy client (bypassed in local mode)
│   ├── middleware/
│   │   ├── auth.js                   # Auth (disabled locally)
│   │   ├── rate-limit.js             # Rate limiting (disabled locally)
│   │   └── validation.js             # Schema validation
│   └── utils/
│       ├── logger.js                 # Structured JSON logger
│       └── errors.js                 # Error classes
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│       └── scripts/                  # Sample skill scripts for testing
├── data/
│   └── gcs/                          # GCS emulator data (git-ignored)
│       └── awa-skills-dev/
│           ├── user-scripts/         # Place .js skill scripts here
│           └── approved-skills/      # Pre-approved skills directory
├── scripts/
│   ├── seed-scripts.js               # Upload sample scripts to GCS
│   └── benchmark.js                  # Load testing
├── docker-compose.yml                # Production stack (worker + GCS emulator)
├── Dockerfile                        # Production worker image
├── .dockerignore                     # Docker build context exclusions
├── package.json
└── .env                              # Local environment variables
```

> **Note:** The `data/gcs/` directory is mounted as a volume into both the worker container and the GCS emulator. Any file you place in `data/gcs/awa-skills-dev/user-scripts/` is immediately available for the emulator to serve.

---

## 5. Quick Start

### 5.1 Using the VS Code Dev Container (Recommended)

```bash
# 1. Open the project
code /workspace

# 2. When prompted "Reopen in Container?", click it
#    Or press F1 → "Dev Containers: Reopen in Container"
```

VS Code will:
1. Build the dev container image (Node.js 20, Chromium, Playwright, `isolated-vm`, `gcloud` CLI).
2. Start the `fake-gcs-server` sidecar container on port 4443.
3. Run `post-create.sh` to install npm dependencies, create seed directories, and generate a `.env` file.
4. Mount `data/gcs/` as a shared writable volume.

**The worker is ready.** Start it with:

```bash
npm run dev
```

### 5.2 Without VS Code (Standalone Docker Compose)

The project includes a root-level `docker-compose.yml` that runs the AWA Worker in a production-like container alongside the GCS emulator.

```bash
# 1. Start the full stack (worker + GCS emulator)
docker compose up -d

# 2. Create the GCS skills bucket (first time only)
curl -s -X POST http://localhost:4443/storage/v1/b \
  -H "Content-Type: application/json" \
  -d '{"name":"awa-skills-dev"}' > /dev/null

# 3. Verify the worker is healthy
curl http://localhost:9808/healthz

# 4. Install the mpx-awa CLI globally (for seeding & session management)
npm install -g ./mpx-awa

# 5. Scaffold and seed a skill
mpx-awa init mrbeast.store
mpx-awa seed mrbeast.store
```

> **Note:** The worker starts automatically when the container launches — no manual `npm run dev` needed.
>
> Seed directories are created automatically inside the GCS emulator's Docker volume. You can also place files directly at `data/gcs/awa-skills-dev/user-scripts/` if you mount a local directory. For the dev container stack, use `.devcontainer/docker-compose.yml`:
>
> ```bash
> docker compose -f .devcontainer/docker-compose.yml up -d
> ```

### 5.3 Verify It's Running

```bash
# Health check (worker is on port 9808 from the host)
curl http://localhost:9808/healthz
# → {"status":"healthy","uptime":...,"activeSessions":0,"isolatePoolSize":20,"chromiumStatus":"running"}

# GCS emulator
curl http://localhost:4443/storage/v1/b
# → {"kind":"storage#buckets","items":[...]}
```

---

## 6. Local Configuration

### 6.1 Environment Variables (`.env`)

The following configuration is tuned for local development. Key differences from production are annotated below.

```bash
# ─── Server ───────────────────────────────────────────
PORT=8080
NODE_ENV=development

# ─── GCS Emulator ─────────────────────────────────────
GCS_ENDPOINT=http://gcs-emulator:4443   # Point to fake-gcs-server
GCS_BUCKET=awa-skills-dev               # Local bucket name
GCS_PROJECT_ID=openclaw-dev             # Fake project ID

# ─── Isolate Sandbox ──────────────────────────────────
ISOLATE_MEMORY_LIMIT_MB=128             # Same as production
ISOLATE_TIMEOUT_MS=30000                # Same as production
ISOLATE_POOL_SIZE=5                     # Smaller pool for local (prod: 20)

# ─── Browser Pool ─────────────────────────────────────
BROWSER_POOL_SIZE=10                    # Smaller pool for local (prod: 40)
CHROME_PATH=/usr/bin/chromium           # System Chromium path

# ─── Proxy (disabled locally) ─────────────────────────
PROXY_MODE=none                         # ← CRITICAL: skip proxy locally
PROXY_PROVIDER_URL=                     # Not needed
PROXY_API_KEY=                          # Not needed

# ─── Rate Limiting (relaxed locally) ──────────────────
RATE_LIMIT_DOMAIN=100                   # Higher limit for testing
RATE_LIMIT_GLOBAL=5000                  # Higher limit for testing

# ─── Logging ──────────────────────────────────────────
LOG_LEVEL=debug                         # Verbose logging in dev
```

### 6.2 Configuration Mapping: Local → GCP

| Variable            | Local Value                | GCP Value           | Notes                               |
| ------------------- | -------------------------- | ------------------- | ----------------------------------- |
| `GCS_ENDPOINT`      | `http://gcs-emulator:4443` | *(unset / default)* | Unset → real GCS SDK auto-detection |
| `GCS_BUCKET`        | `awa-skills-dev`           | `awa-skills-prod`   | Change bucket name                  |
| `GCS_PROJECT_ID`    | `openclaw-dev`             | `openclaw-prod`     | Change project ID                   |
| `ISOLATE_POOL_SIZE` | `5`                        | `20`                | Increase for production             |
| `BROWSER_POOL_SIZE` | `10`                       | `40`                | Increase for production             |
| `PROXY_MODE`        | `none`                     | `residential`       | Enable proxy in production          |
| `PROXY_API_KEY`     | *(empty)*                  | Secret Manager ref  | Set via `--set-secrets`             |
| `RATE_LIMIT_DOMAIN` | `100`                      | `10`                | Tighter limits in production        |
| `RATE_LIMIT_GLOBAL` | `5000`                     | `500`               | Tighter limits in production        |
| `LOG_LEVEL`         | `debug`                    | `info`              | Less verbose in production          |
| `NODE_ENV`          | `development`              | `production`        | Enables production optimizations    |

---

## 7. Working with Skill Scripts

### 7.1 Adding a Sample Script

Place a merchant skill script in the GCS emulator's data directory:

```bash
# Create the directory if it doesn't exist
mkdir -p data/gcs/awa-skills-dev/user-scripts

# Write a sample bestbuy.com script
cat > data/gcs/awa-skills-dev/user-scripts/bestbuy.com.js << 'SCRIPT'
async function execute({ page, targetUrl, sku, quantity, options }) {
  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  // ... your interaction logic here ...

  return {
    status: 'success',
    checkoutUrl: targetUrl.replace('/p/', '/checkout/') + sku
  };
}
SCRIPT
```

The `fake-gcs-server` serves this file immediately — no upload command needed. The path `data/gcs/awa-skills-dev/user-scripts/bestbuy.com.js` maps to the GCS object `gs://awa-skills-dev/user-scripts/bestbuy.com.js`.

### 7.2 Using the Seed Script

If a `scripts/seed-scripts.js` utility exists, you can also seed scripts programmatically:

```bash
node scripts/seed-scripts.js
```

This script should use the `@google-cloud/storage` client pointed at `GCS_ENDPOINT` to upload fixtures.

### 7.3 Using the Session-Based API

```bash
# 1. Start a session
SESSION=$(curl -s -X POST http://localhost:9808/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "mrbeast.store"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")

# 2. Dispatch an action
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "getProduct", "params": {"sku": "test123"}}'

# 3. End the session
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/end"
```

Expected responses:

```json
// Session start
{"sessionId":"sess_abc123","status":"ready","domain":"mrbeast.store",...}

// Action success
{"status":"success","data":{...},"sessionId":"sess_abc123"}

// Action failure
{"status":"failed","data":null,"errorDetails":"Execution memory threshold exceeded.","sessionId":"sess_abc123"}

// Session end
{"status":"closed","sessionId":"sess_abc123","duration":42}
```

> **Tip:** Use `make session DOMAIN=mrbeast.store` / `make action ID=sess_abc ACTION=getProduct` / `make end ID=sess_abc` for the same workflow.

### 7.4 Running Tests

```bash
# Unit tests — fast, no external deps
npm run test:unit

# Integration tests — require GCS emulator running
npm run test:integration

# E2E tests — require full stack (worker + emulator + Chromium)
npm run test:e2e
```

---

## 8. Debugging Locally

### 8.1 Verbose Logging

With `LOG_LEVEL=debug`, the worker outputs structured JSON for every step:

```json
{"level":"debug","msg":"Creating new V8 isolate","sessionId":"abc123"}
{"level":"debug","msg":"Fetching manifest from GCS","bucket":"awa-skills-dev","domain":"mrbeast.store"}
{"level":"debug","msg":"Navigating to target URL","url":"https://www.bestbuy.com/site/product/6534211","sessionId":"abc123"}
{"level":"info","msg":"Script completed","status":"success","duration":1234,"sessionId":"abc123"}
```

### 8.2 Headed Chromium

To watch what Playwright is doing in a visible browser window:

```bash
# In .env
PLAYWRIGHT_HEADLESS=false
```

Then restart the worker and execute a request. A Chromium window will appear on your host.

> **Note:** Headed mode requires the dev container to have GUI forwarding capabilities. On Linux hosts with X11, this works out of the box if the `DISPLAY` variable is set. On macOS/Windows, use VcXsrv or XQuartz.

### 8.3 Isolate Inspection

Enable the V8 inspector in your local `isolate-pool.js`:

```javascript
const isolate = new ivm.Isolate({
  memoryLimit: 128,
  inspector: true,  // Enable V8 inspector (disabled in production)
});
```

### 8.4 GCS Emulator Inspection

The `fake-gcs-server` exposes its own API for introspection:

```bash
# List buckets
curl http://localhost:4443/storage/v1/b

# List objects in a bucket
curl http://localhost:4443/storage/v1/b/awa-skills-dev/o

# Fetch an object directly
curl http://localhost:4443/awa-skills-dev/user-scripts/mrbeast.store/skill.js
```

---

## 9. Common Local Development Issues

| Issue                               | Symptom                                                  | Cause & Fix                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **GCS connection refused**          | `Error: connect ECONNREFUSED 127.0.0.1:4443`             | GCS emulator not started. Run `docker compose up -d` or check `docker ps`.                                                  |
| **Script not found**                | `"SkillNotFound"`                                         | Manifest or script not in the right path. Place files at `data/gcs/awa-skills-dev/user-scripts/<domain>/manifest.json` and `skill.js`. |
| **Chromium launch failure**         | `Error: Failed to launch browser`                        | Missing Chromium. Use bundled Chromium (`npx playwright install chromium`).                                 |
| **Isolate OOM**                     | `"errorDetails": "Execution memory threshold exceeded."` | Script uses too much memory. Reduce complexity or increase `ISOLATE_MEMORY_LIMIT_MB.`                                       |
| **Port conflict**                   | `Error: listen EADDRINUSE :::8080`                       | Another process on port 8080 (internal) or 9808 (host). Change `PORT` in `.env` or `docker-compose.yml`'s host mapping.       |
| **Kernel too old for Chromium**     | Chromium crash on startup                                | The dev container uses a seccomp profile. Ensure `.devcontainer/seccomp-default.json` exists.                               |
| **npm install fails (isolated-vm)** | `gyp ERR! build error`                                   | Missing build tools. The dev container includes `python3`, `make`, `g++`. Outside the dev container, install them manually. |

---

## 10. Migration Path: Local → GCP

The migration from local to GCP is designed to be a **configuration change, not a code change**. Follow these steps in order.

### Phase 1: Prepare GCP Resources

| Step                     | Command / Action                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Create GCP project       | `gcloud projects create openclaw-prod`                                                                    |
| Enable APIs              | `gcloud services enable run.googleapis.com storage.googleapis.com artifactregistry.googleapis.com`        |
| Create Artifact Registry | `gcloud artifacts repositories create awa-worker --repository-format=docker --location=us-central1`       |
| Create GCS bucket        | `gcloud storage buckets create gs://awa-skills-prod --location=us-central1 --uniform-bucket-level-access` |
| Upload skill scripts     | `gcloud storage cp data/gcs/awa-skills-dev/user-scripts/*.js gs://awa-skills-prod/user-scripts/`          |
| Create VPC connector     | See `DEPLOYMENT.md` §7.1                                                                                  |
| Create Cloud NAT         | See `DEPLOYMENT.md` §7.2                                                                                  |
| Store secrets            | `gcloud secrets create proxy-api-key --data-file=-`                                                       |
| Create service account   | `gcloud iam service-accounts create awa-worker-sa`                                                        |

### Phase 2: Configuration Switch

| Variable        | Local Value                | →   | GCP Value                       |
| --------------- | -------------------------- | --- | ------------------------------- |
| `GCS_ENDPOINT`  | `http://gcs-emulator:4443` | →   | *(unset — let SDK auto-detect)* |
| `GCS_BUCKET`    | `awa-skills-dev`           | →   | `awa-skills-prod`               |
| `PROXY_MODE`    | `none`                     | →   | `residential`                   |
| `PROXY_API_KEY` | *(empty)*                  | →   | Secret Manager reference        |
| `NODE_ENV`      | `development`              | →   | `production`                    |
| `LOG_LEVEL`     | `debug`                    | →   | `info`                          |

### Phase 3: Container Build & Deploy

```bash
# 1. Build the production image
docker build -t awa-worker:latest .

# 2. Tag and push to Artifact Registry
docker tag awa-worker:latest \
  us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest
docker push \
  us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest

# 3. Deploy to Cloud Run (see DEPLOYMENT.md §4 for full flags)
gcloud run deploy awa-worker \
  --image=us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest \
  --region=us-central1 \
  --memory=2Gi --cpu=2 --concurrency=40 --timeout=60 \
  --set-env-vars="NODE_ENV=production,GCS_BUCKET=awa-skills-prod,..." \
  --set-secrets="PROXY_API_KEY=proxy-api-key:latest"
```

### Phase 4: Verify in GCP

```bash
# 4. Test the deployed service
curl -X POST https://awa-worker-xxxxx-uc.a.run.app/v1/awa/execute \
  -H "Content-Type: application/json" \
  -d '{"domain":"bestbuy.com","sku":"6534211","targetUrl":"https://www.bestbuy.com/site/product/6534211"}'
```

### Phase 5: Tear Down Local (Optional)

Once GCP deployment is verified, you may stop the local stack:

```bash
docker compose down -v
```

---

## 11. Configuration Reference

### 11.1 All Environment Variables

| Variable                  | Default       | Local Dev                  | GCP Prod                 | Description                     |
| ------------------------- | ------------- | -------------------------- | ------------------------ | ------------------------------- |
| `PORT`                    | `8080`        | `8080`                     | `8080`                   | HTTP server port                |
| `NODE_ENV`                | `development` | `development`              | `production`             | Runtime mode                    |
| `GCS_ENDPOINT`            | *(auto)*      | `http://gcs-emulator:4443` | *(unset)*                | GCS custom endpoint (emulator)  |
| `GCS_BUCKET`              | —             | `awa-skills-dev`           | `awa-skills-prod`        | Skills bucket name              |
| `GCS_PROJECT_ID`          | *(auto)*      | `openclaw-dev`             | `openclaw-prod`          | GCP project ID                  |
| `ISOLATE_MEMORY_LIMIT_MB` | `128`         | `128`                      | `128`                    | V8 isolate memory cap           |
| `ISOLATE_TIMEOUT_MS`      | `30000`       | `30000`                    | `30000`                  | Script execution timeout        |
| `ISOLATE_POOL_SIZE`       | `20`          | `5`                        | `20`                     | Pre-warmed isolate count        |
| `BROWSER_POOL_SIZE`       | `40`          | `10`                       | `40`                     | Max concurrent browser contexts |
| `CHROME_PATH`             | *(auto)*      | `/usr/bin/chromium`        | `/usr/bin/google-chrome` | Browser binary path             |
| `PROXY_MODE`              | `none`        | `none`                     | `residential`            | Proxy mode                      |
| `PROXY_PROVIDER_URL`      | —             | *(empty)*                  | *(set)*                  | Proxy provider endpoint         |
| `PROXY_API_KEY`           | —             | *(empty)*                  | Secret Manager           | Proxy authentication            |
| `RATE_LIMIT_DOMAIN`       | `10`          | `100`                      | `10`                     | Max requests/domain/minute      |
| `RATE_LIMIT_GLOBAL`       | `500`         | `5000`                     | `500`                    | Max requests/global/minute      |
| `LOG_LEVEL`               | `info`        | `debug`                    | `info`                   | Logging verbosity               |

### 11.2 Feature Toggles for Local Dev

| Feature              | Local Behavior                   | How to Enable for GCP                  |
| -------------------- | -------------------------------- | -------------------------------------- |
| **Auth middleware**  | Disabled (no IAM in local dev)   | Enable by validating OIDC tokens       |
| **Rate limiting**    | Relaxed (higher limits)          | Tighten to production values           |
| **Proxy**            | Bypassed (`PROXY_MODE=none`)     | Set `PROXY_MODE=residential` + API key |
| **V8 Inspector**     | Optional (debugging)             | Disabled (`inspector: false`)          |
| **Browser headless** | Toggle via `PLAYWRIGHT_HEADLESS` | Always headless                        |
| **Secrets**          | Plaintext in `.env`              | Secret Manager                         |

---

## 12. Testing the Migration Readiness

Before deploying to GCP, run this checklist to confirm your local setup is migration-ready:

- [ ] Worker starts with `NODE_ENV=production` locally (`npm start`).
- [ ] All unit tests pass (`npm run test:unit`).
- [ ] Integration tests pass with the GCS emulator (`npm run test:integration`).
- [ ] E2E tests pass against a real (non-proxy) merchant URL.
- [ ] Script timeout at 30s works correctly.
- [ ] Isolate OOM at 128MB triggers cleanly.
- [ ] No hardcoded GCP endpoints or credentials in source code.
- [ ] All GCP-specific logic is behind configuration flags or `NODE_ENV` checks.
- [ ] `GCS_ENDPOINT` is only set in `.env` — never hardcoded in `script-loader.js`.
- [ ] Proxy is disabled via `PROXY_MODE=none` — no code paths depend on it in dev.
- [ ] Dockerfile (production) does not depend on dev-only packages.
- [ ] Secrets are referenced via environment variables, not hardcoded.
- [ ] Local `data/gcs/` seed scripts can be uploaded to GCS with a single `gsutil cp`.

---

## 13. Docker Compose Reference

### 13.1 Services

| Service        | Image                                     | Ports       | Purpose                |
| -------------- | ----------------------------------------- | ----------- | ---------------------- |
| `worker`       | Custom build (`.devcontainer/Dockerfile`) | `8080:8080` | AWA worker Express app |
| `gcs-emulator` | `fsouza/fake-gcs-server:latest`           | `4443:4443` | Local GCS emulation    |

### 13.2 Volumes

| Volume             | Mount Point                                         | Purpose              |
| ------------------ | --------------------------------------------------- | -------------------- |
| `awa-gcs-data`     | `/data` (emulator) + `/workspace/data/gcs` (worker) | Shared GCS data      |
| `awa-npm-cache`    | `/home/node/.npm`                                   | Persist npm cache    |
| `awa-bash-history` | `/home/node/.bash_history`                          | Persist bash history |

### 13.3 Networks

All services communicate over the `awa-dev-net` bridge network. The worker reaches the GCS emulator via the hostname `gcs-emulator:4443`.

---

## 14. Related Documentation

| Document          | Description                                        |
| ----------------- | -------------------------------------------------- |
| `ARCHITECTURE.md` | System architecture and component design           |
| `API.md`          | Complete API specification with schemas            |
| `SDD.md`          | Software Design Document (baseline)                |
| `DEPLOYMENT.md`   | GCP deployment guide                               |
| `DEVELOPMENT.md`  | General development guide (dev container, tests)   |
| `SECURITY.md`     | Security model, threat analysis, sandbox deep-dive |
