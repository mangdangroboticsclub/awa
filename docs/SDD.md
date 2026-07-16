This is the formal **Software Design Document (SDD)** for the OpenClaw Agentic Web Actions (AWA) subsystem. It builds on your architectural principles and maps the exact system interfaces, data structures, sandbox configurations, and security controls required for engineering to begin building.

---

# Software Design Document (SDD)

## System Component: OpenClaw Agentic Web Actions (AWA) Multi-Tenant Runtime Engine

* **Document Version:** 3.0.0
* **Status:** APPROVED / BASELINE
* **Target System Components:** OpenClaw Brain, Cloud Run Core Worker, Google Cloud Storage, PWA Chat Client

---

## 1. System Context & Component Boundary

The AWA subsystem isolates unstable third-party merchant interaction code from the core orchestration engine. Instead of scaling infrastructure infinitely per merchant, this design leverages a **session-based, multi-tenant engine** using secure JavaScript virtualization. Each session pairs a persistent V8 isolate with a persistent Playwright browser context, enabling OpenClaw to dispatch multiple actions (search, getProduct, addToCart, getCheckoutLink) within a single user interaction flow.

```
+──────────────────────────────────────────────────────────────────────────────────────────+
|                                    GOOGLE CLOUD PROJECT                                  |
|                                                                                          |
|  +───────────────────+  Session lifecycle + actions   +───────────────────────────────+  |
|  |  OpenClaw Brain   | ─────────────────────────────> |   Cloud Run Core Worker       |  |
|  |  (Main Core App)  │                                |   (Node.js Runtime Host)      │  |
|  |                   │ <───────────────────────────── |                               |  |
|  |  • Orchestration  │   JSON responses               │   • Session Manager           │  |
|  |  • Decision AI    │                                │   • Session #1: {             │  |
|  +───────────────────+                                │   │   isolate,                │  |
|                                                       │   │   context,                │  |
|                                                       │   │   page,                   │  |
|                                                       │   │   skill }                 │  |
|                                                       │   • Session #2: {...}         │  |
|                                                       │   • ... (up to 40)            │  |
|                                                       └───────────────┬───────────────+  |
|                                                                       │                  |
|                                                          Fetches skill│on session start  |
|                                                                       ▼                  |
|  +───────────────────+                               +───────────────────────────────+  |
|  |  Cloud Storage    |                               |      Per-Session Resources    |  |
|  |  (Skills Bucket)  |                               |                               |  |
|  |                   |                               |  ┌─────────────────────────┐  |  |
|  |  user-scripts/    |                               |  │  V8 Isolate Sandbox     │  |  |
|  |  └── bestbuy.com/ │                               |  │  (128MB, 30s timeout)   │  |  |
|  |      ├── skill.js │                               |  │  • Skill handlers loaded│  |  |
|  |      └── manifest.json                            |  │  • $awa.* API injected  │  |  |
|  |                   |                               |  └──────────┬──────────────┘  |  |
|  +───────────────────+                               |             │                  |
|                                                      |  ┌──────────▼──────────────┐  |  |
|                                                      |  │  Playwright Page       │  |  |
|                                                      |  │  (BrowserContext)      │  |  |
|                                                      |  │  • Persists per session│  |  |
|                                                      |  │  • State on close      │  |  |
|                                                      |  └──────────┬──────────────┘  |  |
|                                                      └─────────────┼─────────────────┘  |
|                                                                    │                    |
|                                                                    │ Routes Egress      |
|                                                                    ▼                    |
|                                                      +───────────────────────────────+  |
|                                                      |   Rotating Residential Proxy  |  |
|                                                      +───────────────┬───────────────+  |
+──────────────────────────────────────────────────────────────────────┼──────────────────+
                                                                       │
                                                                       ▼
                                                          [ Target Merchant Endpoint ]

```

---

## 2. Technical Component Deep-Dive

### 2.1 The Cloud Run Core Worker Host

The Host is a stateless Express application deployed onto Google Cloud Run. It is globally packaged alongside Chromium and Playwright dependencies.

* **Initialization Behavior:** On container start, the worker creates a long-lived instance of `playwright-extra` utilizing the `StealthPlugin`.
* **Multitenancy Optimization:** Container instance scaling handles up to 40 scripts concurrently by multiplexing independent `BrowserContext` and `Page` objects across separate memory structures.

### 2.2 The V8 Isolate Isolation Layer (`isolated-vm`)

To allow raw developer script compilation securely within a single container without exposing the underlying filesystem or environment variables, the system executes code using explicit hardware V8 isolates:

* **Memory Ceiling Constraint:** Every script allocation is pinned to an absolute maximum allocation budget of **128MB**. Exceeding this boundary instantly kills the internal isolate loop without crashing the parent Express micro-cluster.
* **Execution Time Boundary:** An independent execution thread timeout kills script operation after precisely **30 seconds**.

---

## 3. Data Dictionary & Contract Specification

### 3.1 Session Start Request

* **Endpoint Path:** `POST /v1/awa/session/start`
* **Content-Type:** `application/json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SessionStartRequest",
  "type": "object",
  "properties": {
    "domain": { "type": "string", "examples": ["bestbuy.com"] },
    "capabilities": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Requested capabilities (omit for all)"
    }
  },
  "required": ["domain"]
}
```

### 3.2 Session Start Response

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SessionStartResponse",
  "type": "object",
  "properties": {
    "sessionId": { "type": "string" },
    "status": { "type": "string", "enum": ["ready"] },
    "domain": { "type": "string" },
    "capabilities": { "type": "array", "items": { "type": "string" } },
    "createdAt": { "type": "string", "format": "date-time" },
    "expiresAt": { "type": "string", "format": "date-time" }
  },
  "required": ["sessionId", "status", "domain"]
}
```

### 3.3 Action Dispatch Request

* **Endpoint Path:** `POST /v1/awa/session/{sessionId}/action`
* **Content-Type:** `application/json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ActionRequest",
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "One of the capabilities declared in the skill manifest",
      "examples": ["search", "getProduct", "addToCart", "getCheckoutLink"]
    },
    "params": {
      "type": "object",
      "description": "Parameters passed to the handler function",
      "examples": [{ "sku": "6534211", "targetUrl": "https://..." }]
    }
  },
  "required": ["action"]
}
```

### 3.4 Action Dispatch Response

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ActionResponse",
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["success", "failed"] },
    "data": { "description": "Handler-specific result data" },
    "errorDetails": { "type": "string" },
    "sessionId": { "type": "string" }
  },
  "required": ["status", "sessionId"]
}
```

### 3.5 Skill Manifest Schema

```
GCS Path: gs://<bucket>/user-scripts/<domain>/manifest.json
```

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AWASkillManifest",
  "type": "object",
  "required": ["domain", "capabilities"],
  "properties": {
    "domain": { "type": "string" },
    "version": { "type": "string", "default": "1.0.0" },
    "capabilities": {
      "type": "array",
      "items": { "type": "string" }
    },
    "urls": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "timeout": { "type": "integer", "default": 30000 },
    "memoryLimitMB": { "type": "integer", "default": 128 }
  }
}
```

### 3.6 Skill Script Structure

```
GCS Path: gs://<bucket>/user-scripts/<domain>/skill.js
```

The skill script exports a `handlers` object where each key is an action name and each value is an async handler function:

```javascript
module.exports = {
  manifest: {
    domain: "bestbuy.com",
    version: "1.0.0",
    capabilities: ["search", "getProduct", "addToCart", "getCheckoutLink"],
    urls: {
      search: "https://www.bestbuy.com/search?q={query}",
      product: "https://www.bestbuy.com/site/product/:sku",
      cart: "https://www.bestbuy.com/cart",
      checkout: "https://www.bestbuy.com/checkout"
    }
  },
  handlers: {
    async search({ query, page }) {
      await $awa.navigate(`https://www.bestbuy.com/search?q=${query}`);
      const results = await $awa.extractText(".search-results");
      return { results };
    },
    async getProduct({ sku, targetUrl, page }) {
      await $awa.navigate(targetUrl);
      const title = await $awa.extractText(".product-title");
      const price = await $awa.extractText(".price-value");
      return { title, price, sku };
    },
    async addToCart({ sku, quantity, options, page }) {
      await $awa.click(".add-to-cart-button");
      await $awa.waitForSelector(".cart-confirmation", 5000);
      return { status: "added" };
    },
    async getCheckoutLink({ page }) {
      await $awa.click(".checkout-button");
      await $awa.waitForNavigation();
      return { checkoutUrl: page.url() };
    }
  }
};
```

---

## 4. Operational & Infrastructure Control Matrix

### 4.1 Container Build Configuration Matrix (`Dockerfile`)

```dockerfile
# Stage 1: Builder — compile native addons
FROM node:20-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm install --production

# Stage 2: Runtime
FROM node:20-slim
ENV NODE_ENV=production

# Install system dependencies for headless Chromium
RUN apt-get update && apt-get install -y \
    chromium wget ca-certificates procps \
    libgconf-2-4 libatk1.0-0 libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 libgtk-3-0 libgbm1 \
    libnss3 libxss1 libasound2 curl \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules

# Install Playwright's bundled Chromium (runs reliably in Docker)
USER node
RUN mkdir -p /home/node/.cache/ms-playwright && \
    npx playwright install chromium 2>&1

COPY package.json ./
COPY src/ ./src/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD curl -sf http://localhost:8080/healthz || exit 1
USER node
CMD ["node", "src/server.js"]
```

### 4.2 Security & Compliance Guardrails

1. **State Elimination:** Cookies, local storage profiles, and transient processing data are explicitly deleted upon the invocation of `await context.close()` on the per-session `BrowserContext`. The storage platform holds no user credit cards, personal names, or delivery profiles.
2. **Asset Screening Compliance Checklist:** The CI/CD validation worker checks all uploaded script code packages against an abstract syntax tree parser to enforce structural checks:
* Rejects strings referencing native access methods: `process`, `require`, `module`, `global`, `import`.
* Rejects payloads exceeding a structural file storage budget of **10MB**.



---

## 5. Failure State & Exception Handling Matrix

| Error Condition Trigger          | Root System Consequence                                                           | Graceful System Mitigation Strategy                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Isolate Memory Overflow (>128MB) | The V8 sub-thread triggers an immediate internal memory abort signal.             | Host intercepts the exception block and returns `status: "failed"` along with `errorDetails: "Execution memory threshold exceeded."`. Session is terminated. |
| Action Timeout (>30s)            | The worker host interrupts action execution via the isolate supervisor mechanism. | Aborts active page actions, returns failure for the current action. Session remains alive for retry.                                                         |
| Session Idle Timeout (15min)     | Background sweeper detects no action for 15 minutes.                              | Closes browser context, disposes isolate. Session becomes `"expired"`. Next action returns 404.                                                              |
| Merchant Security Blocking       | The proxy network returns standard HTTP `403 Forbidden` or challenge loops.       | The action returns `status: "failed"` with `errorDetails: "Merchant blocking detected"`.                                                                     |