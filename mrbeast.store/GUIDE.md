# AWA Skill Script Development Guide

> **Agentic Web Actions (AWA)** — OpenClaw Multi-Tenant Runtime Engine  
> **Version:** 2.0.0 — Session-Based Agentic Skills

---

## 1. What is an AWA Skill Script?

An **AWA skill script** is a JavaScript module that defines **multiple action handlers** for interacting with a merchant website. Unlike a simple fire-and-forget script, AWA skills are **session-based**: OpenClaw opens a session, dispatches discrete actions (search, get product info, add to cart, get checkout link), and the browser context persists across all actions.

Each skill runs inside a **hardware-enforced V8 sandbox** (`isolated-vm`) with:

- **128MB memory cap** — scripts that exceed this are killed instantly
- **30s per-action timeout** — each action is independently timed
- **No filesystem access** — `require`, `process`, `fs`, `module` are blocked
- **No network access** — all egress goes through a controlled Playwright page
- **Safe API surface** — only `$awa.*` primitives are available

The sandbox is **multi-tenant**: dozens of skills from different merchants can run concurrently inside a single container without interfering with each other.

---

## 2. Skill Architecture

### 2.1 Two Files Per Skill

Each skill consists of two files stored in GCS:

```
gs://awa-skills-prod/user-scripts/<domain>/
├── manifest.json       # Declares domain, capabilities, URL patterns
└── skill.js            # Handler implementations
```

### 2.2 Skill Manifest (`manifest.json`)

The manifest declares what the skill can do and which URLs it accesses:

```json
{
  "domain": "bestbuy.com",
  "version": "1.0.0",
  "capabilities": ["search", "getProduct", "addToCart", "getCheckoutLink"],
  "urls": {
    "search": "https://www.bestbuy.com/search?q={query}",
    "product": "https://www.bestbuy.com/site/product/:sku",
    "cart": "https://www.bestbuy.com/cart",
    "checkout": "https://www.bestbuy.com/checkout"
  }
}
```

| Field          | Required | Description                                          |
| -------------- | -------- | ---------------------------------------------------- |
| `domain`       | ✅        | Merchant domain this skill targets                   |
| `version`      | ❌        | Skill version (semver, default: "1.0.0")             |
| `capabilities` | ✅        | Array of action names the skill provides             |
| `urls`         | ❌        | URL templates for key pages (used for reference/doc) |

### 2.3 Skill Script (`skill.js`)

The script exports a `manifest` object and a `handlers` object:

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
      // ... implementation
    },
    async getProduct({ sku, targetUrl, page }) {
      // ... implementation
    },
    async addToCart({ sku, quantity, options, page }) {
      // ... implementation
    },
    async getCheckoutLink({ page }) {
      // ... implementation
    }
  }
};
```

### 2.4 How It Works

```
OpenClaw                          AWA Worker
   │                                  │
   │  POST /session/start             │
   │  { domain: "bestbuy.com" }       │
   │─────────────────────────────────>│
   │                                  │  Load manifest.json + skill.js from GCS
   │                                  │  Create V8 isolate, inject $awa.* API
   │                                  │  Create BrowserContext + Page
   │  { sessionId, status: "ready" }  │
   │<─────────────────────────────────│
   │                                  │
   │  POST /session/:id/action        │
   │  { action: "getProduct",         │
   │    params: { sku, targetUrl } }  │
   │─────────────────────────────────>│
   │                                  │  Call skill.handlers.getProduct(params)
   │                                  │  Isolate navigates, extracts data
   │  { status: "success", data }     │
   │<─────────────────────────────────│
   │                                  │
   │  POST /session/:id/action        │
   │  { action: "addToCart", ... }    │
   │─────────────────────────────────>│
   │                                  │  Call skill.handlers.addToCart(params)
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
- `getProduct` navigates to a product page and extracts details
- `addToCart` clicks the add-to-cart button on the already-loaded page
- `getCheckoutLink` navigates to checkout and returns the URL

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
return { title: "Product Name", price: 49.99, inStock: true };

// Failure
throw new Error("Could not find product element");
```

The return value is placed under the `data` field in the API response.

### 3.3 Standard Handler Implementations

```javascript
handlers: {
  // ── Search ─────────────────────────────────────────
  async search({ query, page }) {
    await $awa.navigate(`https://www.bestbuy.com/search?q=${query}`);
    await $awa.waitForSelector(".search-results", 10000);
    const resultsHtml = await $awa.extractHtml(".search-results");
    return { query, resultsCount: countResults(resultsHtml) };
  },

  // ── Get Product Details ────────────────────────────
  async getProduct({ sku, targetUrl, page }) {
    await $awa.navigate(targetUrl);
    await $awa.waitForSelector(".product-title", 10000);
    return {
      title: await $awa.extractText(".product-title"),
      price: await $awa.extractText(".price-value"),
      sku,
      inStock: !(await $awa.extractText(".out-of-stock"))
    };
  },

  // ── Add to Cart ────────────────────────────────────
  async addToCart({ sku, quantity, options, page }) {
    if (options?.size) await $awa.select(".size-selector", options.size);
    await $awa.click(".add-to-cart-button");
    await $awa.waitForSelector(".cart-confirmation", 5000);
    return { status: "added", sku, quantity };
  },

  // ── Get Checkout Link ──────────────────────────────
  async getCheckoutLink({ page }) {
    await $awa.click(".checkout-button");
    await $awa.waitForNavigation();
    return { checkoutUrl: page.url() };
  }
}
```

### Parameters

| Parameter   | Type     | Required | Description                                           |
| ----------- | -------- | -------- | ----------------------------------------------------- |
| `targetUrl` | `string` | ✅        | Fully qualified URL of the product page               |
| `sku`       | `string` | ✅        | Stock-keeping unit identifier                         |
| `quantity`  | `number` | ❌        | Number of units (default: 1)                          |
| `options`   | `object` | ❌        | Product variants like `{ size: "M", color: "black" }` |

### Return Value

| Field          | Type     | Required | Description                                       |
| -------------- | -------- | -------- | ------------------------------------------------- |
| `status`       | `string` | ✅        | One of: `"success"`, `"failed"`, `"out_of_stock"` |
| `checkoutUrl`  | `string` | ❌        | Checkout URL on success                           |
| `errorDetails` | `string` | ❌        | Human-readable error description                  |

```javascript
// Success
return { status: "success", checkoutUrl: "https://example.com/checkout/abc123" };

// Out of stock
return { status: "out_of_stock", errorDetails: "SKU 12345 is currently unavailable" };

// Failure
return { status: "failed", errorDetails: "Could not find add-to-cart button" };
```

---

## 3. The `$awa.*` API Reference

The sandbox injects a global `$awa` object with the following methods. These are the **only** way to interact with the merchant website.

### 3.1 Navigation

#### `$awa.navigate(url)`

Navigates the browser to a URL. Waits for the page to finish loading (network idle).

```javascript
await $awa.navigate("https://www.bestbuy.com/site/product/6534211");
```

#### `$awa.waitForNavigation()`

Waits for the page to navigate (e.g., after clicking a link or submitting a form). Waits until the `"load"` event fires.

```javascript
await $awa.click(".checkout-button");
await $awa.waitForNavigation();
```

### 3.2 DOM Interaction

#### `$awa.click(selector)`

Clicks the first element matching the CSS selector. Throws if no element is found.

```javascript
await $awa.click(".add-to-cart-button");
```

#### `$awa.type(selector, text)`

Fills an input field with the given text. Clears any existing content first.

```javascript
await $awa.type("#email", "user@example.com");
await $awa.type("#quantity-input", "2");
```

#### `$awa.select(selector, value)`

Selects an option from a `<select>` element by value.

```javascript
await $awa.select(".size-selector", "M");
await $awa.select(".color-selector", "black");
```

### 3.3 Data Extraction

#### `$awa.extractText(selector)`

Returns the text content of the first matching element. Returns `null` if no element is found.

```javascript
const title = await $awa.extractText(".product-title");
const price = await $awa.extractText(".price-value");
```

#### `$awa.extractAttribute(selector, attr)`

Returns the value of an attribute on the first matching element.

```javascript
const imageUrl = await $awa.extractAttribute(".product-image", "src");
const sku = await $awa.extractAttribute(".add-to-cart", "data-sku");
```

#### `$awa.extractHtml(selector)`

Returns the inner HTML of the first matching element.

```javascript
const descriptionHtml = await $awa.extractHtml(".product-description");
```

### 3.4 Waiting

#### `$awa.waitForSelector(selector, timeoutMs)`

Waits for an element matching the CSS selector to appear in the DOM and become visible. Throws after `timeoutMs` milliseconds.

```javascript
await $awa.waitForSelector(".add-to-cart-button", 5000);
await $awa.waitForSelector(".checkout-success", 10000);
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
async function execute({ targetUrl, sku, quantity, options }) {
  // Navigate to product page
  await $awa.navigate(targetUrl);

  // Wait for product to load
  await $awa.waitForSelector(".product-title", 10000);

  // Select options if provided
  if (options?.size) await $awa.select(".size-selector", options.size);
  if (options?.color) await $awa.select(".color-selector", options.color);

  // Click add to cart
  await $awa.click(".add-to-cart-button");

  // Wait for cart to update
  await $awa.waitForSelector(".cart-count", 5000);

  // Go to checkout
  await $awa.click(".checkout-button");
  await $awa.waitForNavigation();

  return {
    status: "success",
    checkoutUrl: "https://example.com/checkout/abc",
  };
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
- **Keep responses lean** — return only what OpenClaw needs to make decisions
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
  manifest: { domain: "example.com", capabilities: ["getProduct"] },
  handlers: {
    async getProduct({ sku, targetUrl, page }) {
      await $awa.navigate(targetUrl);
      return { title: await $awa.extractText(".title") };
    }
  }
};

// ✅ Correct: using $awa.* methods
await $awa.navigate(url);
const title = await $awa.extractText(".title");

// ✅ Correct: returning structured results
return { title: "Product", price: 49.99 };
```

### ⚠️ `module.exports` IS Allowed

The new session-based skill format **requires** `module.exports` to export the `manifest` and `handlers` objects. The AST screener has been updated to allow `module.exports` and `exports` while still blocking `process`, standalone `require` calls, and other dangerous patterns.

### 6.1 Robust Selectors

Prefer stable, semantic CSS selectors:

```javascript
// ✅ Good — data attributes
await $awa.click("[data-testid='add-to-cart']");

// ✅ Good — CSS classes with semantic meaning
await $awa.click(".add-to-cart-button");

// ❌ Avoid — fragile positional selectors
await $awa.click("div:nth-child(3) > button");

// ❌ Avoid — implementation-specific
await $awa.click("#root > div > div > button");
```

### 6.2 Defensive Waiting

Always wait for elements before interacting with them:

```javascript
// ✅ Good: wait then act
await $awa.waitForSelector(".checkout-button", 5000);
await $awa.click(".checkout-button");

// ❌ Bad: race condition
await $awa.click(".checkout-button"); // Might not exist yet
```

### 6.3 Graceful Error Handling

Handle missing elements and unexpected states:

```javascript
async function execute({ targetUrl, sku }) {
  await $awa.navigate(targetUrl);

  // Check if product is in stock
  const outOfStock = await $awa.extractText(".out-of-stock-message");
  if (outOfStock) {
    return { status: "out_of_stock", errorDetails: `SKU ${sku} is out of stock` };
  }

  try {
    await $awa.waitForSelector(".add-to-cart", 5000);
    await $awa.click(".add-to-cart");
  } catch (err) {
    return { status: "failed", errorDetails: "Could not find add-to-cart button" };
  }

  return { status: "success", checkoutUrl: targetUrl + "/checkout" };
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
  -d '{"action": "getProduct", "params": {"sku": "1234567", "targetUrl": "https://yourdomain.com/product/1234567"}}'

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

For example, a skill for `bestbuy.com`:
```
gs://awa-skills-prod/user-scripts/bestbuy.com/
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
return { title: "Product", price: 49.99 };
return { checkoutUrl: "https://..." };
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
     │  { sessionId }                 │  │  Session Manager    │
     │<───────────────────────────────│  │                     │
     │                                │  │  Session #1:        │
     │  POST /session/:id/action      │  │  ├─ V8 Isolate      │
     │  { action: "search", ... }     │  │  │  (128MB, 30s)    │
     │───────────────────────────────>│  │  │  └─ Skill handlers│
     │                                │  │  │     + $awa.* API │
     │  { status, data }              │  │  │                  │
     │<───────────────────────────────│  │  └─ Playwright Page │
     │                                │  │     (BrowserContext)│
     │  POST /session/:id/action      │  │                     │
     │  { action: "addToCart", ... }  │  │     ╔══════════════╗│
     │───────────────────────────────>│  │     ║  Persistent  ║│
     │                                │  │     ║  per session ║│
     │  { status, data }              │  │     ╚══════════════╝│
     │<───────────────────────────────│  │                     │
     │                                │  └─────────────────────┘
     │  POST /session/:id/end         │         │
     │───────────────────────────────>│         │
     │  { status: "closed" }          │   ┌─────▼──────┐
     │<───────────────────────────────│   │   Proxy    │
                                          │  or Direct │
                                          └─────┬──────┘
                                                │
                                          ┌─────▼──────┐
                                          │ Merchant   │
                                          │ Site       │
                                          └────────────┘
  ```

For more details, see the [AWA Architecture documentation](../docs/ARCHITECTURE.md), [API spec](../docs/API.md), and [Security Model](../docs/SECURITY.md) in the main project.
