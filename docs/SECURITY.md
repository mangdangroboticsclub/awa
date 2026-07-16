# Security Model — OpenClaw AWA Multi-Tenant Runtime Engine

> **Version:** 1.0.0  
> **Status:** DRAFT  
> **Classification:** INTERNAL — Security Sensitive  

---

## 1. Threat Model

### 1.1 Trust Boundaries

```
┌──────────────────┐         ┌──────────────────────────────────────┐
│   OpenClaw Brain │         │         Cloud Run Worker             │
│   (Trusted)      │  HTTP   │  ┌────────────────────────────────┐  │
│                  │ ──────> │  │  Express Server (Trusted)       │  │
│                  │         │  └──────────┬───────────────────────┘  │
└──────────────────┘         │             │                          │
                             │     ┌───────▼────────┐                │
                             │     │  Isolate Pool   │                │
                             │     │  (Isolation     │                │
                             │     │   Boundary)     │                │
                             │     └───────┬────────┘                │
                             │             │                          │
                             │     ┌───────▼────────┐                │
                             │     │  Untrusted      │                │
                             │     │  Merchant       │                │
                             │     │  Script Code    │                │
                             │     └────────────────┘                │
                             └──────────────────────────────────────┘

Trust Boundary #1: Brain ↔ Worker (internal GCP, IAM-protected)
Trust Boundary #2: Worker Host ↔ Isolate Sandbox (hardware-enforced)
Trust Boundary #3: Isolate ↔ Merchant Site (via proxy, untrusted egress)
```

### 1.2 Assets at Risk

| Asset | Location | Risk if Compromised |
|---|---|---|
| Merchant script source code | GCS bucket + isolate memory | IP theft, script modification |
| Proxy API credentials | Secret Manager | Unauthorized proxy usage, billing abuse |
| GCS service account key | Secret Manager | Unauthorized storage access |
| Browser session data | Isolate memory (ephemeral) | PII leakage (mitigated by state elimination) |
| Worker host process | Cloud Run container | Full sandbox escape |

### 1.3 Adversary Model

| Adversary | Capability | Goal |
|---|---|---|
| Malicious skill developer | Can upload arbitrary JS | Escape sandbox, access host resources, pivot to GCP |
| Compromised merchant site | Serves malicious content | XSS via DOM, exploit Playwright/Chromium bugs |
| External attacker | Can send crafted HTTP requests | DoS, trigger OOM, exploit Express vulnerabilities |
| Rogue tenant | Co-located on same instance | Side-channel attack on other isolates |

---

## 2. Defense Layers

```
Layer 1: Network Security
├── Cloud Run IAM (invoker binding)
├── VPC connector + Cloud NAT (egress-only)
├── Rotating residential proxy (IP anonymization)
└── No public ingress (internal invocation only)

Layer 2: Application Security
├── Request schema validation (JSON Schema draft-07)
├── Rate limiting (per-domain, per-IP, global)
├── Service account authentication (OIDC tokens)
└── Structured logging (no secrets in logs)

Layer 3: Script Sandboxing
├── isolated-vm V8 isolates (hardware-enforced)
├── 128MB memory ceiling
├── 30s execution timeout
├── No filesystem access (no fs, no require, no process)
└── AST-based script screening (CI/CD gate)

Layer 4: Browser Context Isolation
├── Ephemeral BrowserContext per session
├── No persistent cookies or localStorage
├── StealthPlugin for fingerprint randomization
└── Context destroyed after each execution

Layer 5: Data Protection
├── State elimination on browser close
├── No PII stored in worker
├── No credit card or personal data held
└── GCS bucket with least-privilege IAM
```

---

## 3. Sandbox Deep-Dive

### 3.1 `isolated-vm` Configuration

```javascript
const ivm = require('isolated-vm');

function createIsolate() {
  const isolate = new ivm.Isolate({
    memoryLimit: 128,   // MB — hard cap, enforced by V8
    inspector: false,    // Disable debugger in production
  });

  const context = isolate.createContextSync();

  // Expose only a minimal API surface
  context.evalClosureSync(`
    const $awa = {};
    $awa.navigate = ${exposedNavigate};
    $awa.click = ${exposedClick};
    $awa.extractText = ${exposedExtractText};
    // ... other safe primitives
  `);

  return { isolate, context };
}
```

### 3.2 What the Sandbox Cannot Do

| Operation | Blocked By | Consequence |
|---|---|---|
| `require('fs')` | `isolated-vm` — no Node built-ins | `ReferenceError: require is not defined` |
| `process.env` | `isolated-vm` — no process global | `ReferenceError: process is not defined` |
| `global` | AST screener + isolate | Rejected at CI/CD gate |
| `import()` | AST screener | Rejected at CI/CD gate |
| `eval()` / `Function()` | AST screener | Rejected at CI/CD gate |
| Infinite loop | 30s execution timeout | Isolate terminated |
| `new Array(1e9)` | 128MB memory limit | Isolate OOM → killed |
| Network access (direct) | No `fetch`, no `XMLHttpRequest` in isolate | Must use injected `$awa` APIs |

### 3.3 Exposed API Surface

The sandbox receives a controlled set of functions. Each function is a thin wrapper that performs actions via the host's Playwright page:

```javascript
// Primitives injected into the isolate
const api = {
  // Navigation
  $awa.navigate: async (url) => page.goto(url, { waitUntil: 'networkidle' }),

  // DOM Interaction
  $awa.click: async (selector) => page.click(selector),
  $awa.type: async (selector, text) => page.fill(selector, text),
  $awa.select: async (selector, value) => page.selectOption(selector, value),

  // Data Extraction
  $awa.extractText: async (selector) => page.textContent(selector),
  $awa.extractAttribute: async (selector, attr) => page.getAttribute(selector, attr),
  $awa.extractHtml: async (selector) => page.innerHTML(selector),

  // Waiting
  $awa.waitForSelector: async (selector, timeout) => page.waitForSelector(selector, { timeout }),
  $awa.waitForNavigation: async () => page.waitForNavigation(),

  // Utility
  $awa.sleep: async (ms) => new Promise(r => setTimeout(r, ms)),
  $awa.screenshot: async () => page.screenshot({ encoding: 'base64' }),
};
```

---

## 4. AST-Based Script Screening (CI/CD Gate)

### 4.1 Screening Rules

All merchant skill scripts MUST pass AST analysis before being uploaded to the GCS skills bucket.

```javascript
// Pseudocode for the AST screener
const FORBIDDEN_IDENTIFIERS = [
  'process', 'require', 'global', 'globalThis',
];

const FORBIDDEN_STRINGS = [
  'import(', 'eval(', 'Function(', 'Proxy',
  'Reflect.construct', '__proto__', 'constructor.constructor',
];

// Accepted patterns for the execute/handler export
const HANDLER_PATTERNS = [
  /\bhandlers\s*:\s*\{/,                  // session-based: module.exports = { handlers: {...} }
  /\bexecute\s*[=:\(]/,                   // function execute or execute: handler
  /async\s+function\s+execute\s*\(/,      // legacy: async function execute()
];

function screenScript(source) {
  // Rule 1: Maximum file size 10MB
  if (source.length > 10 * 1024 * 1024) {
    throw new RejectionError('Script exceeds maximum size of 10MB');
  }

  // Rule 2: No forbidden identifiers
  for (const ident of FORBIDDEN_IDENTIFIERS) {
    const regex = new RegExp('\\b' + ident + '\\b');
    if (regex.test(source)) {
      throw new RejectionError(`Forbidden identifier: ${ident}`);
    }
  }

  // Rule 3: No forbidden string patterns
  for (const str of FORBIDDEN_STRINGS) {
    if (source.includes(str)) {
      throw new RejectionError(`Forbidden pattern: ${str}`);
    }
  }

  // Rule 4: Must export handlers or an execute function
  const hasHandler = HANDLER_PATTERNS.some((re) => re.test(source));
  if (!hasHandler) {
    throw new RejectionError(
      'Script must define handlers or an async function named "execute"'
    );
  }

  return true;
}
```

### 4.2 Security Review Checklist for Scripts

- [ ] Script exports `module.exports = { handlers: { ... } }` — no side-effect top-level code
- [ ] No `require`, `import`, `process`, `global`, `globalThis` references
- [ ] Uses only injected `$awa.*` primitives for browser interaction
- [ ] No hardcoded credentials, API keys, or tokens
- [ ] All selectors are relative and scoped (avoid global selector pollution)
- [ ] File size ≤ 10MB
- [ ] Passes AST screener before upload

---

## 5. Data Protection & Privacy

### 5.1 State Elimination

After each script execution:

```javascript
async function cleanup(browserContext) {
  // Clear all browsing data
  await browserContext.clearCookies();
  await browserContext.clearPermissions();

  // Close the context
  await browserContext.close();

  // Wait for garbage collection hint
  global.gc && global.gc();
}
```

### 5.2 Data Residency

| Data Type | Location | Retention |
|---|---|---|
| Execution logs | Cloud Logging | 30 days |
| Script source | GCS bucket | Until deleted by admin |
| Execution request/response | In-memory only | Discarded after response sent |
| Browser cookies/cache | In-memory only | Destroyed on context close |
| Proxy session data | Proxy provider | Per provider TOS |

### 5.3 What We DO NOT Store

- ❌ User credit card numbers
- ❌ User names or delivery addresses
- ❌ Session tokens or passwords
- ❌ Browser fingerprint data
- ❌ Personal identifiable information (PII)

---

## 6. Incident Response

### 6.1 Security Event Severity Levels

| Level | Example | Response Time |
|---|---|---|
| **SEV-1** | Sandbox escape detected | Immediate (≤ 15 min) |
| **SEV-2** | Unauthorized GCS access | ≤ 1 hour |
| **SEV-3** | Proxy credential leak | ≤ 4 hours |
| **SEV-4** | Rate limit bypass | ≤ 24 hours |

### 6.2 Response Playbook: Sandbox Escape

1. **Detect:** Alert triggered by isolate crash pattern or anomalous egress.
2. **Contain:** Immediately drain the affected Cloud Run instance (stop serving traffic to that revision).
3. **Analyze:** Review isolate logs, Chromium console output, and egress logs for the affected session.
4. **Patch:** If a script exploit is identified, add AST screening rule and remove script from GCS.
5. **Rotate:** Rotate all credentials that may have been exposed (proxy API key, service account keys).
6. **Reinforce:** Deploy patched version with additional isolation controls.
7. **Postmortem:** Document root cause, timeline, and prevention measures.

---

## 7. Compliance & Auditing

### 7.1 Audit Logging

```javascript
// All security-relevant events are logged as structured JSON
const auditLog = {
  event: 'ISOLATE_CREATED',
  sessionId: 'abc-123',
  domain: 'bestbuy.com',
  timestamp: new Date().toISOString(),
  actor: 'system',
};
```

| Audit Event | Trigger |
|---|---|
| `ISOLATE_CREATED` | New V8 isolate allocated |
| `ISOLATE_OOM` | Isolate exceeded memory limit |
| `ISOLATE_TIMEOUT` | Isolate exceeded execution timeout |
| `SCRIPT_LOADED` | Script fetched from GCS |
| `BROWSER_CONTEXT_CREATED` | New Playwright BrowserContext created |
| `BROWSER_CONTEXT_CLOSED` | BrowserContext cleaned up |
| `PROXY_ERROR` | Proxy connection failure |
| `REQUEST_REJECTED` | Request failed schema validation or rate limit |

### 7.2 Security Scanning

- **Dependency scanning:** `npm audit` runs in CI/CD pipeline
- **Container scanning:** Artifact Registry vulnerability scanning enabled
- **SAST:** AST screener runs on every script upload
- **DAST:** Quarterly penetration testing on worker API

---

## 8. Secure Configuration Checklist

- [ ] Cloud Run ingress set to `internal` (no public internet access)
- [ ] Cloud Run uses service account with minimum required permissions
- [ ] GCS bucket has uniform bucket-level access — no public access
- [ ] GCS bucket enforces object versioning for audit trail
- [ ] Secrets stored in Secret Manager, not in environment variables
- [ ] VPC connector enforces egress-only traffic pattern
- [ ] `NODE_ENV=production` in deployed containers
- [ ] Debug/inspector mode disabled in production
- [ ] Chromium runs with `--no-sandbox` ONLY inside container sandbox
- [ ] Rate limiting enabled globally and per-domain
- [ ] All logs are structured JSON (no plaintext secrets)
- [ ] Container runs as non-root user (enforced in Dockerfile)
