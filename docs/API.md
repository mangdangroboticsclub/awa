# API Specification — OpenClaw AWA Worker Service

> **Version:** 2.0.0  
> **Status:** DRAFT  
> **Base URL:** `https://<worker-service>/v1/awa`  
> **Content-Type:** `application/json`

---

## 1. Session Lifecycle

The AWA Worker uses a **session-based** model. OpenClaw creates a session, dispatches one or more actions against it, then ends the session. The browser context and V8 isolate persist across actions within a session.

```
POST /v1/awa/session/start      → Create session + allocate resources
POST /v1/awa/session/:id/action → Dispatch an action to the session
POST /v1/awa/session/:id/end    → Destroy session + clean up resources
GET  /v1/awa/session/:id        → Get session status
```

---

## 2. Endpoints

### 2.1 Start Session

Creates a new browsing session for a merchant domain. Allocates a V8 isolate, fetches the skill script, creates a Playwright browser context, and injects the `$awa.*` API.

```
POST /v1/awa/session/start
```

#### Request Body

```json
{
  "domain": "bestbuy.com",
  "capabilities": ["search", "getProduct", "addToCart", "getCheckoutLink"]
}
```

| Field          | Type       | Required | Default | Description                                                                      |
| -------------- | ---------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `domain`       | `string`   | ✅        | —       | Merchant domain. Used to look up the skill manifest and script.                  |
| `capabilities` | `string[]` | ❌        | All     | Specific capabilities to load. If omitted, all handlers in the skill are loaded. |

#### Response — Success (200)

```json
{
  "sessionId": "sess_abc123",
  "status": "ready",
  "domain": "bestbuy.com",
  "capabilities": ["search", "getProduct", "addToCart", "getCheckoutLink"],
  "createdAt": "2026-07-07T12:00:00Z",
  "expiresAt": "2026-07-07T12:15:00Z"
}
```

#### Error Responses

| HTTP Status | Condition                            | Body                                                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `400`       | Missing domain or invalid schema     | `{ "error": "ValidationError", "details": "..." }`                                          |
| `404`       | No skill found for domain            | `{ "error": "SkillNotFound", "details": "No skill registered for: bestbuy.com" }`           |
| `422`       | Requested capability not in manifest | `{ "error": "CapabilityNotSupported", "details": "Capability 'checkout' not in manifest" }` |
| `503`       | All worker slots saturated           | `{ "error": "Overloaded", "details": "All worker slots are busy. Retry later." }`           |

---

### 2.2 Dispatch Action

Sends an action to an active session. The action is routed to the corresponding handler function in the skill script. The browser context persists — the handler can navigate, interact, and extract data from the current page state.

```
POST /v1/awa/session/:sessionId/action
```

#### Request Body

```json
{
  "action": "getProduct",
  "params": {
    "sku": "6534211",
    "targetUrl": "https://www.bestbuy.com/site/product/6534211"
  }
}
```

| Field    | Type     | Required | Description                                                                 |
| -------- | -------- | -------- | --------------------------------------------------------------------------- |
| `action` | `string` | ✅        | One of the capabilities declared in the skill manifest.                     |
| `params` | `object` | ❌        | Parameters passed to the handler function. Structure depends on the action. |

#### Standard Action Types

| Action            | Common Params                                         | Description                                   |
| ----------------- | ----------------------------------------------------- | --------------------------------------------- |
| `search`          | `{ query: string }`                                   | Search the merchant site for products         |
| `getProduct`      | `{ sku: string, targetUrl: string }`                  | Navigate to product page, extract details     |
| `addToCart`       | `{ sku: string, quantity: number, options?: object }` | Add product to cart                           |
| `getCheckoutLink` | `{}`                                                  | Navigate to checkout, return the checkout URL |

> Skills may define additional custom actions beyond these standards.

#### Response — Success (200)

```json
{
  "status": "success",
  "data": {
    "title": "Sample Product 6534211",
    "price": 49.99,
    "sku": "6534211",
    "inStock": true
  },
  "sessionId": "sess_abc123"
}
```

#### Response — Failure (200)

```json
{
  "status": "failed",
  "data": null,
  "errorDetails": "Execution memory threshold exceeded.",
  "sessionId": "sess_abc123"
}
```

| Field          | Type     | Required | Description                             |
| -------------- | -------- | -------- | --------------------------------------- |
| `status`       | `string` | ✅        | `"success"` or `"failed"`               |
| `data`         | `any`    | ❌        | Handler-specific result data on success |
| `errorDetails` | `string` | ❌        | Error description on failure            |
| `sessionId`    | `string` | ✅        | Echoes the session ID                   |

#### Error Responses

| HTTP Status | Condition                        | Body                                                                                           |
| ----------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `400`       | Invalid action or missing params | `{ "error": "ValidationError", "details": "..." }`                                             |
| `404`       | Session not found or expired     | `{ "error": "SessionNotFound", "details": "Session sess_abc123 not found" }`                   |
| `422`       | Action not in skill capabilities | `{ "error": "ActionNotSupported", "details": "Action 'ship' not declared in skill manifest" }` |
| `408`       | Action timed out (30s)           | `{ "error": "ActionTimeout", "details": "Action exceeded 30s execution limit" }`               |

---

### 2.3 End Session

Destroys a session, closes the browser context, clears all state, and disposes the isolate.

```
POST /v1/awa/session/:sessionId/end
```

#### Response — Success (200)

```json
{
  "status": "closed",
  "sessionId": "sess_abc123",
  "duration": 120
}
```

| Field       | Type      | Description                 |
| ----------- | --------- | --------------------------- |
| `status`    | `string`  | `"closed"`                  |
| `sessionId` | `string`  | Echoes the session ID       |
| `duration`  | `integer` | Session lifetime in seconds |

---

### 2.4 Get Session Status

Returns the current status of a session.

```
GET /v1/awa/session/:sessionId
```

#### Response — Success (200)

```json
{
  "sessionId": "sess_abc123",
  "status": "active",
  "domain": "bestbuy.com",
  "createdAt": "2026-07-07T12:00:00Z",
  "expiresAt": "2026-07-07T12:15:00Z",
  "actionsExecuted": 3
}
```

---

### 2.5 Health Check

```
GET /healthz
```

Returns the overall worker health. Used by Cloud Run for startup and liveness probes.

#### Response (200)

```json
{
  "status": "healthy",
  "uptime": 3600,
  "activeSessions": 12,
  "maxSessions": 40,
  "isolatePoolSize": 20,
  "chromiumStatus": "running"
}
```

| Field             | Type      | Description                               |
| ----------------- | --------- | ----------------------------------------- |
| `status`          | `string`  | `"healthy"` or `"degraded"`               |
| `uptime`          | `integer` | Container uptime in seconds               |
| `activeSessions`  | `integer` | Number of currently active sessions       |
| `maxSessions`     | `integer` | Maximum concurrent sessions               |
| `isolatePoolSize` | `integer` | Number of pre-warmed V8 isolates          |
| `chromiumStatus`  | `string`  | `"running"`, `"starting"`, or `"crashed"` |

---

## 3. Skill Manifest Schema

Every skill uploaded to GCS must include a `manifest.json` alongside the `skill.js`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AWASkillManifest",
  "type": "object",
  "required": ["domain", "capabilities"],
  "properties": {
    "domain": {
      "type": "string",
      "description": "Merchant domain this skill targets",
      "examples": ["bestbuy.com"]
    },
    "version": {
      "type": "string",
      "description": "Skill version (semver)",
      "default": "1.0.0"
    },
    "capabilities": {
      "type": "array",
      "description": "List of action handlers this skill provides",
      "items": { "type": "string" },
      "examples": [["search", "getProduct", "addToCart", "getCheckoutLink"]]
    },
    "urls": {
      "type": "object",
      "description": "URL templates for key pages",
      "additionalProperties": { "type": "string" },
      "examples": [{
        "search": "https://www.bestbuy.com/search?q={query}",
        "product": "https://www.bestbuy.com/site/product/:sku",
        "cart": "https://www.bestbuy.com/cart",
        "checkout": "https://www.bestbuy.com/checkout"
      }]
    },
    "timeout": {
      "type": "integer",
      "description": "Per-action timeout in ms",
      "default": 30000
    },
    "memoryLimitMB": {
      "type": "integer",
      "description": "Isolate memory limit in MB",
      "default": 128
    }
  }
}
```

---

## 4. Rate Limiting

| Scope                   | Limit              | Window   |
| ----------------------- | ------------------ | -------- |
| Per domain              | 10 session starts  | 1 minute |
| Per IP (Brain → Worker) | 100 requests       | 1 minute |
| Global (all domains)    | 500 session starts | 1 minute |
| Per session             | 30 actions/minute  | 1 minute |

Rate limit headers are returned on every response:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 8
X-RateLimit-Reset: 1625678900
```

---

## 5. Error Codes Reference

| Code                     | HTTP Status | Description                                         |
| ------------------------ | ----------- | --------------------------------------------------- |
| `ValidationError`        | 400         | Request body failed JSON Schema validation          |
| `SkillNotFound`          | 404         | No skill script registered for the requested domain |
| `SessionNotFound`        | 404         | Session ID not found or expired                     |
| `CapabilityNotSupported` | 422         | Requested capability not in skill manifest          |
| `ActionNotSupported`     | 422         | Action not declared in skill capabilities           |
| `RateLimited`            | 429         | Request quota exceeded                              |
| `ActionTimeout`          | 408         | Action exceeded execution time limit                |
| `Overloaded`             | 503         | All worker slots saturated                          |
| `ExecutionFailed`        | 200         | Action execution completed with errors              |
| `MemoryOverflow`         | 200         | Isolate exceeded memory budget                      |
| `MerchantBlocked`        | 200         | Merchant site returned 403 or CAPTCHA challenge     |

---

## 6. Client Example

### cURL — Full Session Lifecycle

```bash
# 1. Start a session
SESSION_ID=$(curl -s -X POST https://<worker-service>/v1/awa/session/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"domain": "bestbuy.com"}' | jq -r '.sessionId')

# 2. Search for a product
curl -s -X POST "https://<worker-service>/v1/awa/session/$SESSION_ID/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "search", "params": {"query": "laptop"}}'

# 3. Get product details
curl -s -X POST "https://<worker-service>/v1/awa/session/$SESSION_ID/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "getProduct", "params": {"sku": "6534211", "targetUrl": "https://www.bestbuy.com/site/product/6534211"}}'

# 4. Add to cart
curl -s -X POST "https://<worker-service>/v1/awa/session/$SESSION_ID/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "addToCart", "params": {"sku": "6534211", "quantity": 1}}'

# 5. Get checkout link
curl -s -X POST "https://<worker-service>/v1/awa/session/$SESSION_ID/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "getCheckoutLink"}'

# 6. End the session
curl -s -X POST "https://<worker-service>/v1/awa/session/$SESSION_ID/end" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>"
```

### Legacy Endpoint

The single-shot `POST /v1/awa/execute` endpoint is **deprecated** and maintained for backward compatibility only. New integrations should use the session-based API above.

```bash
curl -X POST https://<worker-service>/v1/awa/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <service-account-token>" \
  -d '{
    "domain": "bestbuy.com",
    "sku": "6534211",
    "targetUrl": "https://www.bestbuy.com/site/product/6534211",
    "quantity": 1
  }'
```

### Node.js (OpenClaw Brain)

```typescript
const response = await fetch('https://<worker-service>/v1/awa/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`,
  },
  body: JSON.stringify({
    domain: 'bestbuy.com',
    sku: '6534211',
    targetUrl: 'https://www.bestbuy.com/site/product/6534211',
    quantity: 1,
    options: { size: 'M', color: 'black' },
  }),
});

const result: AWAResponse = await response.json();

if (result.status === 'success') {
  console.log('Checkout URL:', result.checkoutUrl);
} else {
  console.error('Failed:', result.errorDetails);
}
```

---

## 7. Versioning & Compatibility

- The API is versioned via the URL path (`/v1/`).
- Breaking changes increment the version number.
- Deprecated versions will be supported for at least 90 days after a new version is announced.
- All responses include a `X-API-Version: 1.0.0` header.
