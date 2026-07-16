"use strict";

/**
 * E2E Tests — Full-stack integration test with the mock merchant site.
 *
 * Tests the complete request lifecycle:
 *   curl → worker → script-loader → browser-pool → isolate-pool → mock site
 *
 * Requires: worker server running, GCS emulator running, mock server running.
 * These tests are skipped unless RUN_E2E=true is set.
 *
 * Usage:
 *   # Terminal 1: Start the worker
 *   npm run dev
 *
 *   # Terminal 2: Start the mock merchant site
 *   node tests/fixtures/mock-server.js
 *
 *   # Terminal 3: Run E2E tests
 *   RUN_E2E=true npx jest tests/e2e/ --forceExit
 */

const RUN_E2E = process.env.RUN_E2E === "true";

const describe_fn = RUN_E2E ? describe : describe.skip;
const WORKER_URL = "http://localhost:8080";
const MOCK_URL = "http://localhost:3000";

describe_fn("E2E: AWA Worker → Mock Merchant", () => {
  beforeAll(() => {
    if (!RUN_E2E) {
      return;
    }
    console.log(`Worker: ${WORKER_URL}`);
    console.log(`Mock:   ${MOCK_URL}`);
  });

  test("worker health check returns healthy", async () => {
    const res = await fetch(`${WORKER_URL}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.chromiumStatus).toBe("running");
  });

  test("mock merchant serves product page", async () => {
    const res = await fetch(`${MOCK_URL}/product/6534211`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sample Product");
    expect(html).toContain("add-to-cart-button");
  });

  test("worker rejects invalid request", async () => {
    const res = await fetch(`${WORKER_URL}/v1/awa/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "bestbuy.com" }), // missing sku + targetUrl
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ValidationError");
  });

  test("worker returns script not found for unknown domain", async () => {
    const res = await fetch(`${WORKER_URL}/v1/awa/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "unknown-merchant.test",
        sku: "123",
        targetUrl: `${MOCK_URL}/product/123`,
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.errorDetails).toBe("Script not found");
  });
});
