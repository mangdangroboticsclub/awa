# mpx-awa — AWA SDK CLI

> **OpenClaw Agentic Web Actions SDK** — Scaffold and develop web automation skill scripts for the AWA multi-tenant runtime engine.

---

## Overview

`mpx-awa` is the official CLI tool for creating **AWA skill scripts** — JavaScript modules that automate website interactions (navigate pages, search content, fill forms, extract data). Skills run inside a secure V8 sandbox with a persistent Playwright browser session.

```
npm install -g mpx-awa
mpx-awa init bestbuy.com
# Creates:
#   bestbuy.com/
#   ├── manifest.json     ← Capabilities, URL patterns
#   ├── skill.js          ← Handler implementations
#   └── GUIDE.md          ← Full development guide
```

---

## Installation

```bash
# From npm registry
npm install -g mpx-awa

# From local path (development)
npm install -g ./mpx-awa

# Or run directly with npx
npx mpx-awa --help
```

---

## Quick Start (Docker Compose)

The AWA Worker runs as a Docker container. Start the full stack (worker + GCS emulator) with:

```bash
# From the project root
docker compose up -d

# Verify the worker is healthy (port 9808 is mapped to the container's 8080)
curl http://localhost:9808/healthz
```

Now use `mpx-awa` from your host to interact with the worker:

```bash
mpx-awa seed bestbuy.com           # Upload skills to GCS
mpx-awa session start bestbuy.com  # Start a session
mpx-awa session action sess_abc123 search '{"query":"laptop"}'
mpx-awa session end sess_abc123
```

---

## Usage

```bash
mpx-awa init <domain>              Scaffold a new skill
mpx-awa seed <domain>              Upload skill to GCS emulator
mpx-awa session start <domain>     Create a new session
mpx-awa session list               List active sessions
mpx-awa session get <id>           Get session status
mpx-awa session action <id> <action> [params]  Dispatch an action
mpx-awa session end <id>           End a session
mpx-awa --help                     Show help
mpx-awa --version                  Show version
```

### Examples

```bash
# 1. Scaffold a skill
mpx-awa init bestbuy.com

# 2. Seed to the GCS emulator (with Docker Compose running)
mpx-awa seed bestbuy.com

# 3. Start a session
mpx-awa session start bestbuy.com
# → { "sessionId": "sess_abc123", "status": "ready", ... }

# 4. Dispatch actions
mpx-awa session action sess_abc123 search '{"query":"laptop"}'
mpx-awa session action sess_abc123 getProduct '{"sku":"6534211","targetUrl":"..."}'

# 5. End the session
mpx-awa session end sess_abc123
```

### Environment Variables

| Variable           | Default                    | Description                                    |
| ------------------ | -------------------------- | ---------------------------------------------- |
| `AWA_WORKER_URL`   | `http://localhost:9808`    | Worker URL for session commands (from host)    |
| `GCS_EMULATOR_URL` | `http://localhost:4443`    | GCS emulator URL for seed command (from host)  |

---

## What Gets Created

Running `mpx-awa init bestbuy.com` generates three files:

### `manifest.json`

Declares the skill's identity, capabilities, and URL patterns. The worker reads this first to validate session requests.

```json
{
  "domain": "bestbuy.com",
  "version": "1.0.0",
  "capabilities": ["getProduct", "addToCart", "getCheckoutLink"],
  "urls": {
    "product": "https://www.bestbuy.com/product/:sku",
    "cart": "https://www.bestbuy.com/cart",
    "checkout": "https://www.bestbuy.com/checkout"
  },
  "timeout": 30000,
  "memoryLimitMB": 128
}
```

### `skill.js`

Implements handler functions for each capability. Runs inside a V8 isolate with the `$awa.*` API surface. The browser page persists across all handler invocations within a session.

```javascript
module.exports = {
  manifest: { domain: "bestbuy.com", capabilities: [...] },
  handlers: {
    async getProduct({ sku, targetUrl, page }) {
      await $awa.navigate(targetUrl);
      return { title: await $awa.extractText(".product-title"), sku };
    },
    async addToCart({ sku, quantity, page }) { ... },
    async getCheckoutLink({ page }) { ... },
  }
};
```

### `GUIDE.md`

A comprehensive development guide covering:
- The `$awa.*` API reference (all 11 methods)
- Handler anatomy and return values
- Execution constraints (128MB, 30s timeout)
- Security rules (forbidden patterns)
- Best practices (selectors, waiting, error handling)
- Local testing and deployment instructions

---

## The `$awa.*` API

| Method                                    | Description                                |
| ----------------------------------------- | ------------------------------------------ |
| `$awa.navigate(url)`                      | Navigate to a URL (waits for network idle) |
| `$awa.click(selector)`                    | Click an element                           |
| `$awa.type(selector, text)`               | Fill an input field                        |
| `$awa.select(selector, value)`            | Select an option                           |
| `$awa.extractText(selector)`              | Get text content                           |
| `$awa.extractAttribute(selector, attr)`   | Get an attribute value                     |
| `$awa.extractHtml(selector)`              | Get inner HTML                             |
| `$awa.waitForSelector(selector, timeout)` | Wait for element to appear                 |
| `$awa.waitForNavigation()`                | Wait for page navigation                   |
| `$awa.sleep(ms)`                          | Pause execution                            |
| `$awa.screenshot()`                       | Take a screenshot (base64)                 |

---

## Deployment

Upload both files to the AWA skills bucket in GCS:

```bash
# Development
gcloud storage cp manifest.json gs://awa-skills-dev/user-scripts/bestbuy.com/
gcloud storage cp skill.js gs://awa-skills-dev/user-scripts/bestbuy.com/

# Production
gcloud storage cp manifest.json gs://awa-skills-prod/user-scripts/bestbuy.com/
gcloud storage cp skill.js gs://awa-skills-prod/user-scripts/bestbuy.com/
```

The GCS path must be: `user-scripts/<domain>/manifest.json` and `user-scripts/<domain>/skill.js`.

---

## Session Lifecycle

```
OpenClaw Brain                    AWA Worker              Merchant Site
     │                                │                        │
     │  POST /session/start           │                        │
     │  { domain: "bestbuy.com" }     │                        │
     │───────────────────────────────>│                        │
     │                                │  Load manifest.json    │
     │                                │  Load skill.js         │
     │                                │  Create V8 isolate     │
     │                                │  Create browser page   │
     │  { sessionId, status:"ready" } │                        │
     │<───────────────────────────────│                        │
     │                                │                        │
     │  POST /session/:id/action      │                        │
     │  { action: "getProduct" }      │                        │
     │───────────────────────────────>│                        │
     │                                │  handler.getProduct()  │
     │                                │───────────────────────>│
     │  { status, data }              │<───────────────────────│
     │<───────────────────────────────│                        │
     │                                │                        │
     │  POST /session/:id/action      │                        │
     │  { action: "addToCart" }       │                        │
     │───────────────────────────────>│                        │
     │                                │  handler.addToCart()   │
     │                                │  (same browser page)   │
     │  { status, data }              │                        │
     │<───────────────────────────────│                        │
     │                                │                        │
     │  POST /session/:id/end         │                        │
     │───────────────────────────────>│                        │
     │                                │  Close page            │
     │                                │  Dispose isolate       │
     │  { status: "closed" }          │                        │
     │<───────────────────────────────│                        │
```

---

## Security Rules

The AWA worker's **AST screener** blocks these patterns in skill scripts:

| Pattern                | Reason                        |
| ---------------------- | ----------------------------- |
| `process`              | Node.js process access        |
| `require`              | Dynamic module loading        |
| `global`, `globalThis` | Global object access          |
| `eval(`                | Dynamic code execution        |
| `Function(`            | Dynamic function construction |
| `Proxy`                | Sandbox escape risk           |
| `Reflect.construct`    | Sandbox escape risk           |
| `constructor.constructor` | Sandbox escape            |
| `import(`              | Dynamic module import         |
| `__proto__`            | Prototype pollution           |

`module.exports` IS allowed — it's required to export your manifest and handlers.

---

## Local Testing

```bash
# 1. Start the AWA worker
npm run dev

# 2. Place your skill in the GCS emulator
mkdir -p data/gcs/awa-skills-dev/user-scripts/yourdomain.com
cp manifest.json data/gcs/awa-skills-dev/user-scripts/yourdomain.com/
cp skill.js data/gcs/awa-skills-dev/user-scripts/yourdomain.com/

# 3. Start a session
SESSION=$(curl -s -X POST http://localhost:9808/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "yourdomain.com"}' | jq -r '.sessionId')

# 4. Dispatch actions
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "getProduct", "params": {"sku": "123", "targetUrl": "https://yourdomain.com/product/123"}}'

# 5. End session
curl -s -X POST "http://localhost:9808/v1/awa/session/$SESSION/end"
```

---

## Related

- [AWA Worker Service](https://github.com/openclaw/mpx-cloud-sdk) — The runtime engine
- [API Specification](../docs/API.md) — Full API reference
- [Architecture Guide](../docs/ARCHITECTURE.md) — System design
- [Security Model](../docs/SECURITY.md) — Sandbox deep-dive

---

## License

MIT — OpenClaw
