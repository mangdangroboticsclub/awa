# AWA Skill Script Development Guide

> **Agentic Web Actions (AWA)** — OpenClaw Multi-Tenant Runtime Engine  
> **Version:** 2.0.0 — Session-Based Agentic Skills

---

## 1. What is an AWA Skill Script?

An **AWA skill script** is a JavaScript module that defines **multiple action handlers** for interacting with a website. Unlike a simple fire-and-forget script, AWA skills are **session-based**: OpenClaw opens a session, dispatches discrete actions (get a page, search content, fill a form), and the browser context persists across all actions.

Each skill runs inside a **hardware-enforced V8 sandbox** (`isolated-vm`) with:

- **128MB memory cap** — scripts that exceed this are killed instantly
- **30s per-action timeout** — each action is independently timed
- **No filesystem access** — `require`, `process`, `fs`, `module` are blocked
- **No network access** — all egress goes through a controlled Playwright page
- **Safe API surface** — only `$awa.*` primitives are available

The sandbox is **multi-tenant**: dozens of skills for different sites can run concurrently inside a single container without interfering with each other.

---

## 2. Skill Architecture

### 2.1 Two Files Per Skill

Each skill consists of two files stored in GCS:

```
gs://awa-skills-prod/user-scripts/<domain>/
├── manifest.json       # Declares domain, capabilities, URL patterns, action docs
└── skill.js            # Handler implementations
```

### 2.2 Skill Manifest (`manifest.json`)

The manifest declares what the skill can do and which URLs it accesses:

```json
{
  "domain": "example.com",
  "version": "1.0.0",
  "capabilities": ["getPage", "searchContent", "extractData"],
  "urls": {
    "home": "https://www.example.com/",
    "search": "https://www.example.com/search?q={query}"
  }
}
```

| Field          | Required | Description                                          |
| -------------- | -------- | ---------------------------------------------------- |
| `domain`       | ✅        | Domain this skill targets                            |
| `version`      | ❌        | Skill version (semver, default: "1.0.0")             |
| `capabilities` | ✅        | Array of action names the skill provides             |
| `urls`         | ❌        | URL templates for key pages (documentation / reference) |
| `readme`       | ❌        | Human/agent-readable description of the skill        |
| `actions`      | ❌        | Structured docs per action — params, returns, examples |

### 2.3 Skill README & Action Docs (Agent Instructions)

Every skill has two layers of documentation for the **agent** (OpenClaw brain):

#### `readme` — Free-form overview
A short description of what the site does and any general caveats.

#### `actions` — Structured per-action docs
This is where the agent learns **exactly** how to use each action. Each action entry documents:

| Field        | Description                                   |
| ------------ | --------------------------------------------- |
| `description` | What this action does                         |
| `params`      | Each parameter: name, type, required, description |
| `returns`     | Each return field and what it contains         |
| `examples`    | Concrete examples of params + expected result  |

```json
"getPage": {
  "description": "Navigate to a page and extract its content.",
  "params": {
    "targetUrl": { "type": "string", "required": false, "description": "Full URL to navigate to." }
  },
  "returns": {
    "url": "The URL that was loaded",
    "pageTitle": "Title of the page"
  },
  "example": {
    "params": { "targetUrl": "https://example.com/page" },
    "result": { "url": "https://example.com/page", "pageTitle": "Page Title" }
  }
}
```

The agent reads this to understand exactly what params to pass and what to expect back.

```
mpx-awa readme example.com                # View README + action docs
mpx-awa readme example.com --json          # Raw JSON (for programmatic use)
mpx-awa readme example.com --set "..."     # Update the free-form README
```

**Tip**: The more precise your `actions` docs are, the better the agent can use your skill without guessing.

### 2.4 Skill Script (`skill.js`)

The script exports a `manifest` object and a `handlers` object:

```javascript
module.exports = {
  manifest: {
    domain: "example.com",
    version: "1.0.0",
    capabilities: ["getPage", "searchContent", "extractData"],
    urls: {
      home: "https://www.example.com/",
      search: "https://www.example.com/search?q={query}"
    }
  },
  handlers: {
    async getPage({ targetUrl, section, page }) {
      // ... implementation
    },
    async searchContent({ query, page }) {
      // ... implementation
    },
    async extractData({ selector, page }) {
      // ... implementation
    }
  }
};
```

The scaffold generates example handlers (`getPage`, `searchContent`, `extractData`, `fillForm`) — these are **placeholders**. Rename them, change their params, and implement the actions your site actually needs. Just keep `manifest.actions` and `handlers` in sync.

### 2.5 How It Works

```
OpenClaw                          AWA Worker
   │                                  │
   │  POST /session/start             │
   │  { domain: "example.com" }       │
   │─────────────────────────────────>│
   │                                  │  Load manifest.json + skill.js from GCS
   │                                  │  Create V8 isolate, inject $awa.* API
   │                                  │  Create BrowserContext + Page
   │  { sessionId, status: "ready" }  │
   │<─────────────────────────────────│
   │                                  │
   │  POST /session/:id/action        │
   │  { action: "getPage",            │
   │    params: { targetUrl } }       │
   │─────────────────────────────────>│
   │                                  │  Call skill.handlers.getPage(params)
   │                                  │  Isolate navigates, extracts data
   │  { status: "success", data }     │
   │<─────────────────────────────────│
   │                                  │
   │  POST /session/:id/action        │
   │  { action: "extractData", ... }  │
   │─────────────────────────────────>│
   │                                  │  Call skill.handlers.extractData(params)
   │                                  │  Same page, new interaction
   │  { status: "success", data }     │
   │<─────────────────────────────────│
   │                                  │
   │  POST /session/:id/end           │
   │─────────────────────────────────>│
   │                                  │  Close context + dispose isolate
   │  { status: "closed" }            │
   │<─────────────────────────────────│
```

The **browser stays open** across all actions in the session. This means:
- `getPage` navigates to a page and extracts content
- `extractData` reads more details from the already-loaded page
- `fillForm` fills and submits a form using the current page state

All within one persistent browser context.

---

## 3. Handler Anatomy

### 3.1 Each Handler Receives

| Parameter   | Type     | Description                                            |
| ----------- | -------- | ------------------------------------------------------ |
| `page`      | `object` | The Playwright Page (set automatically — do not pass)  |
| `...params` | `any`    | Parameters from the action request (varies per action) |

### 3.2 Each Handler Returns

```javascript
// Success
return { title: "Page Title", url: "https://..." };

// Failure
throw new Error("Could not find the expected element");
```

The return value is placed under the `data` field in the API response.

### 3.3 Standard Handler Implementations

```javascript
handlers: {
  async getPage({ targetUrl, page }) {
    await $awa.navigate(targetUrl);
    await $awa.waitForSelector("body", 10000);
    const title = await $awa.extractText("title");
    return { url: targetUrl, pageTitle: title };
  },

  async searchContent({ query, page }) {
    const searchUrl = `https://example.com/search?q=${encodeURIComponent(query)}`;
    await $awa.navigate(searchUrl);
    await $awa.waitForSelector(".results", 10000);
    const resultsHtml = await $awa.extractHtml(".results");
    return { query, resultsHtml };
  },

  async extractData({ selector, page }) {
    return { content: await $awa.extractText(selector) };
  }
}
```

### 3.4 Return Conventions

There are no strict requirements on return shapes — return whatever data is useful to the agent. However, for actions that may fail, a consistent pattern helps:

```javascript
// Success
return { status: "success", result: { ...data } };

// Partial / not found
return { status: "not_found", message: "Element not found" };

// Failure
throw new Error("Timeout waiting for element");
```

---

## 3. The `$awa.*` API Reference

The sandbox injects a global `$awa` object with the following methods. These are the **only** way to interact with the target website.

### 3.1 Navigation

#### `$awa.navigate(url)`

Navigates the browser to a URL. Waits for the page to finish loading (network idle).

```javascript
await $awa.navigate("https://example.com/page");
```

#### `$awa.waitForNavigation()`

Waits for the page to navigate (e.g., after clicking a link or submitting a form).

```javascript
await $awa.click(".submit-button");
await $awa.waitForNavigation();
```

### 3.2 DOM Interaction

#### `$awa.click(selector)`

Clicks the first element matching the CSS selector. Throws if no element is found.

```javascript
await $awa.click(".submit-button");
```

#### `$awa.type(selector, text)`

Fills an input field with the given text. Clears any existing content first.

```javascript
await $awa.type("#email", "user@example.com");
```

#### `$awa.select(selector, value)`

Selects an option from a `<select>` element by value.

```javascript
await $awa.select(".country-select", "US");
```

### 3.3 Data Extraction

#### `$awa.extractText(selector)`

Returns the text content of the first matching element. Returns `null` if no element is found.

```javascript
const heading = await $awa.extractText("h1");
```

#### `$awa.extractAttribute(selector, attr)`

Returns the value of an attribute on the first matching element.

```javascript
const imageUrl = await $awa.extractAttribute(".avatar", "src");
```

#### `$awa.extractHtml(selector)`

Returns the inner HTML of the first matching element.

```javascript
const content = await $awa.extractHtml(".article-body");
```

### 3.4 Waiting

#### `$awa.waitForSelector(selector, timeoutMs)`

Waits for an element matching the CSS selector to appear in the DOM and become visible. Throws after `timeoutMs` milliseconds.

```javascript
await $awa.waitForSelector(".content", 5000);
```

### 3.5 Utility

#### `$awa.sleep(ms)`

Pauses script execution for the given number of milliseconds. Use sparingly — prefer `waitForSelector` or `waitForNavigation` for deterministic timing.

```javascript
await $awa.sleep(1000); // Wait 1 second
```

#### `$awa.screenshot()`

Takes a screenshot of the current page and returns it as a base64-encoded string. Useful for debugging.

```javascript
const screenshot = await $awa.screenshot();
// Screenshot is a base64 data URI string
```

### 3.6 Full Example

```javascript
async function execute({ targetUrl, query }) {
  // Navigate to the page
  await $awa.navigate(targetUrl);

  // Wait for content to load
  await $awa.waitForSelector(".search-box", 10000);

  // Type a search query
  await $awa.type(".search-box", query);

  // Submit
  await $awa.click(".search-button");
  await $awa.waitForNavigation();

  // Extract results
  const results = await $awa.extractHtml(".results");

  return { url: page.url(), results };
}
```

---

## 4. Execution Constraints

| Constraint               | Value              | Behavior When Exceeded                                           |
| ------------------------ | ------------------ | ---------------------------------------------------------------- |
| **Memory**               | 128 MB per session | Session killed. Returns `"Execution memory threshold exceeded."` |
| **Per-action timeout**   | 30 seconds         | Action terminated. Session remains alive for retry.              |
| **Session idle timeout** | 15 minutes         | Session auto-closed. Next action returns 404.                    |
| **Script size**          | 10 MB              | Rejected at upload by AST screener                               |
| **Concurrent sessions**  | 40 per instance    | New session requests get HTTP 503                                |

### Design Your Handlers Accordingly

- **Each action is independent** — handlers should navigate to the needed URL if page state is unknown
- **Use `waitForSelector` over `sleep`** — deterministic waits make skills more reliable
- **Keep responses lean** — return only what the agent needs to make decisions
- **Handle errors gracefully** — use try/catch within handlers to return meaningful error data

---

## 5. Security Rules (AST Screener)

All skill scripts are checked by an **AST-based screener** before they can be uploaded. Scripts that violate these rules are rejected with a clear error message.

### ❌ Forbidden Identifiers

| Pattern                   | Reason                                |
| ------------------------- | ------------------------------------- |
| `process`                 | Access to Node.js process environment |
| `require` (as expression) | Dynamic module loading                |
| `global`, `globalThis`    | Global object access                  |
| `eval(`                   | Dynamic code execution                |
| `Function(`               | Dynamic function construction         |
| `Proxy`                   | Meta-programming, sandbox escape risk |
| `Reflect.construct`       | Sandbox escape risk                   |
| `__proto__`               | Prototype pollution                   |
| `constructor.constructor` | Sandbox escape                        |
| `import(`                 | Dynamic module import                 |

### ✅ Allowed Patterns

```javascript
// ✅ Correct: module.exports with manifest + handlers
module.exports = {
  manifest: { domain: "example.com", capabilities: ["getPage"] },
  handlers: {
    async getPage({ targetUrl, page }) {
      await $awa.navigate(targetUrl);
      return { title: await $awa.extractText("title") };
    }
  }
};

// ✅ Correct: using $awa.* methods
await $awa.navigate(url);
const title = await $awa.extractText("h1");

// ✅ Correct: returning structured results
return { url: "https://...", title: "Page Title" };
```

### ⚠️ `module.exports` IS Allowed

The session-based skill format **requires** `module.exports` to export the `manifest` and `handlers` objects. The AST screener has been updated to allow `module.exports` and `exports` while still blocking `process`, standalone `require` calls, and other dangerous patterns.

### 6.1 Robust Selectors

Prefer stable, semantic CSS selectors:

```javascript
// ✅ Good — data attributes
await $awa.click("[data-testid='submit']");

// ✅ Good — semantic CSS classes
await $awa.click(".submit-button");

// ❌ Avoid — fragile positional selectors
await $awa.click("div:nth-child(3) > button");

// ❌ Avoid — implementation-specific
await $awa.click("#root > div > div > button");
```

### 6.2 Defensive Waiting

Always wait for elements before interacting with them:

```javascript
// ✅ Good: wait then act
await $awa.waitForSelector(".submit-button", 5000);
await $awa.click(".submit-button");

// ❌ Bad: race condition
await $awa.click(".submit-button"); // Might not exist yet
```

### 6.3 Graceful Error Handling

Handle missing elements and unexpected states:

```javascript
async function execute({ targetUrl }) {
  await $awa.navigate(targetUrl);

  // Check for expected content
  const errorMessage = await $awa.extractText(".error-message");
  if (errorMessage) {
    return { status: "error", message: errorMessage };
  }

  try {
    await $awa.waitForSelector(".content", 5000);
    const data = await $awa.extractText(".content");
    return { status: "success", data };
  } catch (err) {
    return { status: "failed", message: "Content not found" };
  }
}
```

### 6.4 Testing Locally

```bash
# 1. Start the AWA worker
npm run dev

# 2. Place your skill in the GCS emulator
mkdir -p data/gcs/awa-skills-dev/user-scripts/yourdomain.com
cp manifest.json data/gcs/awa-skills-dev/user-scripts/yourdomain.com/
cp skill.js data/gcs/awa-skills-dev/user-scripts/yourdomain.com/

# 3. Start a session
SESSION_ID=$(curl -s -X POST http://localhost:8080/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -d '{"domain": "yourdomain.com"}' | jq -r '.sessionId')

# 4. Dispatch actions
curl -s -X POST "http://localhost:8080/v1/awa/session/$SESSION_ID/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "getPage", "params": {"targetUrl": "https://yourdomain.com/page"}}'

# 5. End the session
curl -s -X POST "http://localhost:8080/v1/awa/session/$SESSION_ID/end" \
  -H "Content-Type: application/json"
```

---

## 7. Deployment

Upload your skill to the AWA skills bucket:

```bash
# Development / staging
gcloud storage cp manifest.json gs://awa-skills-dev/user-scripts/yourdomain.com/
gcloud storage cp skill.js gs://awa-skills-dev/user-scripts/yourdomain.com/

# Production
gcloud storage cp manifest.json gs://awa-skills-prod/user-scripts/yourdomain.com/
gcloud storage cp skill.js gs://awa-skills-prod/user-scripts/yourdomain.com/
```

The worker fetches both files by domain. The GCS path must be:
`user-scripts/<domain>/manifest.json`
`user-scripts/<domain>/skill.js`

For example, a skill for `example.com`:
```
gs://awa-skills-prod/user-scripts/example.com/
├── manifest.json
└── skill.js
```

---

## 8. Quick Reference

```javascript
// ─── Navigation ───────────────────────────────────────
await $awa.navigate(url);

// ─── Waiting ──────────────────────────────────────────
await $awa.waitForSelector(selector, timeoutMs);
await $awa.waitForNavigation();
await $awa.sleep(ms);

// ─── Interaction ──────────────────────────────────────
await $awa.click(selector);
await $awa.type(selector, text);
await $awa.select(selector, value);

// ─── Extraction ───────────────────────────────────────
const text = await $awa.extractText(selector);
const attr = await $awa.extractAttribute(selector, name);
const html = await $awa.extractHtml(selector);

// ─── Utility ──────────────────────────────────────────
const screenshot = await $awa.screenshot(); // base64

// ─── Return ───────────────────────────────────────────
return { url: "https://...", title: "Page Title" };
return { status: "success", data: "..." };
throw new Error("Element not found");
```

---

## 9. Architecture Overview

```
OpenClaw Brain                    AWA Worker
     │                                │
     │  POST /session/start           │
     │───────────────────────────────>│
     │                                │  ┌─────────────────────┐
     │  { sessionId }                │  │  Session Manager     │
     │<───────────────────────────────│  │                     │
     │                                │  │  Session #1:        │
     │  POST /session/:id/action      │  │  ├─ V8 Isolate      │
     │  { action: "getPage", ... }    │  │  │  (128MB, 30s)    │
     │───────────────────────────────>│  │  │  └─ Skill handlers│
     │                                │  │  │     + $awa.* API │
     │  { status, data }              │  │  │                  │
     │<───────────────────────────────│  │  └─ Playwright Page │
     │                                │  │     (BrowserContext)│
     │  POST /session/:id/action      │  │                     │
     │  { action: "extractData" }     │  │     ╔══════════════╗│
     │───────────────────────────────>│  │     ║  Persistent  ║│
     │                                │  │     ║  per session  ║│
     │  { status, data }              │  │     ╚══════════════╝│
     │<───────────────────────────────│  │                     │
     │                                │  └─────────────────────┘
     │  POST /session/:id/end         │         │
     │───────────────────────────────>│         │
     │  { status: "closed" }          │   ┌─────▼──────┐
     │<───────────────────────────────│   │   Proxy    │
                                        │  or Direct  │
                                        └─────┬──────┘
                                              │
                                        ┌─────▼──────┐
                                        │   Target   │
                                        │   Website  │
                                        └────────────┘
```

For more details, see the [AWA Architecture documentation](../docs/ARCHITECTURE.md), [API spec](../docs/API.md), and [Security Model](../docs/SECURITY.md) in the main project.
