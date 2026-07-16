# Architecture Guide — OpenClaw AWA Multi-Tenant Runtime Engine

> **Version:** 2.0.0  
> **Status:** DRAFT  
> **Supersedes:** SDD v2.0.0 (architecture section)  

---

## 1. System Overview

The OpenClaw Agentic Web Actions (AWA) subsystem provides a **session-based, multi-tenant runtime** for executing third-party merchant interaction scripts. Unlike a fire-and-forget execution model, AWA maintains **long-lived sessions** where OpenClaw can dispatch multiple discrete actions (search, get product info, add to cart, get checkout link) against a single persistent browser context.

This enables truly **agentic web skills**: OpenClaw's orchestration engine can explore a merchant site, gather information, make decisions, and execute transactions — all within one secured, sandboxed session.

### 1.1 Key Design Principles

| Principle                    | Rationale                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Privacy by Design**        | User browsing data never leaves the ephemeral session context. Cookies, cache, and state are eliminated on session end. |
| **Defense in Depth**         | Three layers of isolation: network proxy, V8 isolate sandbox, and ephemeral browser contexts.              |
| **Session-Based**            | Browser context persists across multiple actions within a session. OpenClaw controls session lifecycle.    |
| **Fail-Fast Isolation**      | A single runaway action cannot crash the host process or affect other tenants.                             |
| **Capability-Driven**        | Each skill declares a manifest of URLs and capabilities (search, getProduct, addToCart, etc.) it supports. |
| **Skill Marketplace**        | Developers are incentivized to build and publish secure, reusable skill scripts for merchant domains.      |
| **Egress-Only Architecture** | Workers never accept inbound connections from the internet; they only route outbound via rotating proxies. |

---

## 2. Component Architecture

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           GOOGLE CLOUD PROJECT                                    │
│                                                                                  │
│  ┌────────────────────────┐     Session Lifecycle           ┌─────────────────┐  │
│  │   OpenClaw Brain       │ ─── POST /v1/awa/session/start ─>  Cloud Run Core  │  │
│  │   (Core App)           │                                    Worker (Node)   │  │
│  │                        │ <─── { sessionId, status } ──────                │  │
│  │  • Orchestration       │                                    │               │  │
│  │  • Decision making     │ ─── POST /v1/awa/session/:id/action ─>            │  │
│  │  • Session lifecycle   │        { action: "getProduct", sku }              │  │
│  │                        │ <─── { status, product, price } ───              │  │
│  │                        │                                    │               │  │
│  │                        │ ─── POST /v1/awa/session/:id/action ─>            │  │
│  │                        │        { action: "addToCart", quantity }          │  │
│  │                        │ <─── { status, cartUrl } ──────────              │  │
│  │                        │                                    │               │  │
│  │                        │ ─── POST /v1/awa/session/:id/end ──>             │  │
│  │                        │ <─── { status: "closed" } ────────              │  │
│  └────────────────────────┘                                    │               │
│                                                                 │               │
│                                                    ┌────────────▼───────────┐  │
│                                                    │   Persistent Session    │  │
│                                                    │   per sessionId         │  │
│                                                    │                         │  │
│                                                    │  ┌───────────────────┐  │  │
│  ┌────────────────────────┐     Script Fetch       │  │  V8 Isolate        │  │  │
│  │   Cloud Storage        │ ◄──────────────────────┐  │  (128MB, 30s/action)│  │
│  │   (Skills Bucket)      │     by domain          │  │  • Skill handlers  │  │
│  │                        │                        │  │  • $awa.* API      │  │
│  │  • user-scripts/       │                        │  └────────┬──────────┘  │  │
│  │  • <domain>/           │                        │           │              │  │
│  │    ├─ skill.js         │                        │  ┌────────▼──────────┐  │  │
│  │    └─ manifest.json    │                        │  │  Playwright Page  │  │  │
│  └────────────────────────┘                        │  │  (BrowserContext) │  │  │
│                                                    │  └────────┬──────────┘  │  │
│                                                    └───────────┼─────────────┘  │
│                                                                │                │
│                                                    ┌───────────▼─────────────┐ │
│                                                    │  Rotating Residential   │ │
│                                                    │  Proxy                  │ │
│                                                    └───────────┬─────────────┘ │
└────────────────────────────────────────────────────────────────┼───────────────┘
                                                                 │
                                                                 ▼
                                                    [ Target Merchant Site ]
```

### 2.2 Component Responsibilities

| Component                         | Role                                                                                                                                   | Technology                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **OpenClaw Brain**                | Core orchestration engine. Manages session lifecycle, dispatches actions, makes decisions based on results.                            | Node.js (main app)                              |
| **Cloud Run Core Worker**         | Stateful HTTP server that maintains active sessions (isolate + browser page per session). Routes actions to the correct skill handler. | Node.js, Express                                |
| **V8 Isolate Sandbox**            | Hardware-enforced memory/CPU isolation for untrusted merchant scripts. One isolate per session.                                        | `isolated-vm`                                   |
| **Playwright Page**               | Headless Chromium browser context. Persists across multiple actions in a session.                                                      | Playwright + `playwright-extra` + StealthPlugin |
| **Cloud Storage (Skills Bucket)** | Stores merchant skill scripts with manifests. Workers fetch skills on session start.                                                   | Google Cloud Storage                            |
| **Rotating Residential Proxy**    | Egress proxy pool that routes traffic through residential IPs to evade merchant bot detection.                                         | Third-party proxy provider                      |

---

## 3. Data Flow

### 3.1 Session Lifecycle

```
┌──────────────┐                    ┌──────────────────┐                    ┌──────────────┐
│  OpenClaw    │                    │  AWA Worker      │                    │  Merchant    │
│  Brain       │                    │                  │                    │  Site        │
└──────┬───────┘                    └────────┬─────────┘                    └──────┬─────────┘
       │                                     │                                    │
       │  POST /session/start                │                                    │
       │  { domain: "bestbuy.com" }          │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Fetch skill script from GCS       │
       │                                     │  Create V8 isolate                 │
       │                                     │  Create BrowserContext + Page      │
       │                                     │  Inject $awa.* API                 │
       │  { sessionId: "abc", status: "ready" }                                  │
       │<────────────────────────────────────│                                    │
       │                                     │                                    │
       │  POST /session/abc/action           │                                    │
       │  { action: "search", query: "..." } │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Call skill.search(query)          │
       │                                     │  Isolate navigates, extracts      │
       │                                     │────────────────────────────────────>│
       │                                     │<────────────────────────────────────│
       │  { status: "success", results: [...] }                                   │
       │<────────────────────────────────────│                                    │
       │                                     │                                    │
       │  POST /session/abc/action           │                                    │
       │  { action: "getProduct", sku }      │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Call skill.getProduct(sku)        │
       │                                     │  Same page, new navigation        │
       │                                     │────────────────────────────────────>│
       │                                     │<────────────────────────────────────│
       │  { status: "success", title, price }                                     │
       │<────────────────────────────────────│                                    │
       │                                     │                                    │
       │  POST /session/abc/action           │                                    │
       │  { action: "addToCart", quantity }  │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Call skill.addToCart(sku, qty)    │
       │                                     │────────────────────────────────────>│
       │                                     │<────────────────────────────────────│
       │  { status: "success", cartUrl }                                           │
       │<────────────────────────────────────│                                    │
       │                                     │                                    │
       │  POST /session/abc/action           │                                    │
       │  { action: "getCheckoutLink" }      │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Call skill.getCheckoutLink()      │
       │                                     │────────────────────────────────────>│
       │                                     │<────────────────────────────────────│
       │  { status: "success", checkoutUrl }                                      │
       │<────────────────────────────────────│                                    │
       │                                     │                                    │
       │  POST /session/abc/end              │                                    │
       │────────────────────────────────────>│                                    │
       │                                     │  Close BrowserContext              │
       │                                     │  Dispose isolate                   │
       │  { status: "closed" }              │                                    │
       │<────────────────────────────────────│                                    │
```

### 3.2 Skill Manifest

Each skill script is accompanied by a manifest that declares the domain, supported capabilities, and URL patterns:

```
gs://awa-skills-prod/user-scripts/bestbuy.com/
├── skill.js            # Handler implementations
└── manifest.json       # Domain, capabilities, URL patterns
```

**manifest.json:**
```json
{
  "domain": "bestbuy.com",
  "version": "1.0.0",
  "capabilities": [
    "search",
    "getProduct",
    "addToCart",
    "getCheckoutLink"
  ],
  "urls": {
    "search": "https://www.bestbuy.com/search?q={query}",
    "product": "https://www.bestbuy.com/site/product/:sku",
    "cart": "https://www.bestbuy.com/cart",
    "checkout": "https://www.bestbuy.com/checkout"
  },
  "timeout": 30000,
  "memoryLimitMB": 128
}
```

### 3.3 Script Fetching Strategy

1. OpenClaw sends `POST /session/start` with a `domain`.
2. Worker fetches the skill manifest from `gs://<bucket>/user-scripts/<domain>/manifest.json`.
3. Worker validates the requested capability is in the manifest.
4. Worker fetches the skill script from `gs://<bucket>/user-scripts/<domain>/skill.js`.
5. Script source and manifest are cached in-memory (LRU, 5min TTL).
6. On `POST /session/:id/action`, the worker routes the action to the correct handler function inside the isolate.

---

## 4. Concurrency Model

### 4.1 Container-Level Multiplexing

A single Cloud Run instance can handle **up to 40 concurrent sessions**. Each session holds:

- One `isolated-vm` `Isolate` instance (pre-warmed from pool)
- One Playwright `BrowserContext` with a single `Page`
- The skill's handler functions compiled into the isolate

Sessions are long-lived — they persist across multiple action invocations until explicitly ended by OpenClaw or terminated by timeout (default: 15 minutes idle).

```
Cloud Run Instance
├── Chromium Process (single)
│   ├── BrowserContext #1 (Session A)
│   │   └── Page #1
│   │   └── Isolate #1 ── Skill: bestbuy.com
│   ├── BrowserContext #2 (Session B)
│   │   └── Page #2
│   │   └── Isolate #2 ── Skill: walmart.com
│   └── ... (up to 40 sessions)
│
├── Express HTTP Server
│   └── Router
│       ├── POST /v1/awa/session/start
│       ├── POST /v1/awa/session/:id/action
│       └── POST /v1/awa/session/:id/end
│
└── Session Manager
    ├── Session #1: { isolate, context, page, skill, createdAt }
    ├── Session #2: { isolate, context, page, skill, createdAt }
    └── ... (up to 40)
```

### 4.2 Scaling Behavior

| Metric                                | Threshold                              | Action |
| ------------------------------------- | -------------------------------------- | ------ |
| CPU utilization > 70%                 | Scale out: add Cloud Run instances     |
| Concurrent sessions > 35 per instance | Scale out: add Cloud Run instances     |
| Memory usage > 80% per instance       | Stop accepting new requests (HTTP 503) |
| Cold start latency > 2s               | Pre-warm pool of 5 isolates at boot    |

---

## 5. Failure Modes & Recovery

| Failure                                   | Detection                         | Recovery                                                          |
| ----------------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Isolate OOM ( >128MB)                     | `isolated-vm` throws `RangeError` | Return `failed` response for the action; session is destroyed     |
| Action timeout ( >30s)                    | Timer watchdog fires              | Abort action; session remains alive for retry                     |
| Merchant 403 / CAPTCHA                    | HTTP status code check            | Return `failed` with `errorDetails: "Merchant blocking detected"` |
| Chromium crash                            | Process health monitor            | Restart Chromium; fail active sessions gracefully                 |
| Session idle timeout (15 min)             | Background sweeper                | Close context, dispose isolate, remove session                    |
| Cloud Run instance termination (scale-in) | SIGTERM signal                    | Drain active sessions with 10s grace period                       |
| GCS fetch failure                         | HTTP 404/403 from GCS             | Return `failed` with `errorDetails: "Skill not found for domain"` |

---

## 6. Network Architecture

```
Internet
    │
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Google Cloud Load Balancer (HTTPS)                                   │
│ └── Cloud Run (serverless) — no public IP, egress-only              │
│     └── VPC Connector ──── Cloud NAT ──── Rotating Proxy Provider   │
│                                              └── Merchant Sites      │
└──────────────────────────────────────────────────────────────────────┘
```

All worker-to-merchant traffic egresses through a rotating residential proxy provider to:
- Bypass geo-restrictions
- Avoid IP-based rate limiting
- Defeat bot detection heuristics
- Provide merchant-specific IP whitelisting capability

---

## 7. Technology Stack

| Layer              | Technology                                            | Version Constraint |
| ------------------ | ----------------------------------------------------- | ------------------ |
| Runtime            | Node.js                                               | >= 20 (slim)       |
| HTTP Framework     | Express                                               | Latest             |
| Browser Automation | Playwright                                            | Latest             |
| Stealth Plugin     | `playwright-extra` + `puppeteer-extra-plugin-stealth` | Latest             |
| JS Sandbox         | `isolated-vm`                                         | Latest             |
| Cloud Compute      | Google Cloud Run                                      | —                  |
| Object Storage     | Google Cloud Storage                                  | —                  |
| Container          | Docker                                                | Node 20-slim base  |
| Proxy              | Residential proxy provider (TBD)                      | —                  |
