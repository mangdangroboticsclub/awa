"use strict";

const express = require("express");
const request = require("supertest");

// ---------------------------------------------------------------------------
// Mock ScriptLoader
// ---------------------------------------------------------------------------
const mockScriptLoaderFetch = jest.fn();
const mockScriptLoaderFetchManifest = jest.fn();
jest.mock("../../src/services/script-loader", () => {
  class LRUCache {
    constructor(maxSize = 100, ttlMs = 300000) {
      this.maxSize = maxSize;
      this.ttlMs = ttlMs;
      this.cache = new Map();
    }
    get(key) {
      const entry = this.cache.get(key);
      if (!entry) return null;
      if (Date.now() - entry.timestamp > this.ttlMs) { this.cache.delete(key); return null; }
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.value;
    }
    set(key, value) {
      if (this.cache.size >= this.maxSize) { const oldest = this.cache.keys().next().value; this.cache.delete(oldest); }
      this.cache.set(key, { value, timestamp: Date.now() });
    }
    clear() { this.cache.clear(); }
    get size() { return this.cache.size; }
  }

  const MockScriptLoader = jest.fn().mockImplementation(() => ({
    fetch: mockScriptLoaderFetch,
    fetchScript: mockScriptLoaderFetch,
    fetchManifest: mockScriptLoaderFetchManifest,
    initialize: jest.fn().mockResolvedValue(undefined),
    clearCache: jest.fn(),
  }));

  return { ScriptLoader: MockScriptLoader, LRUCache };
});

// ---------------------------------------------------------------------------
// Mock IsolatePool
// ---------------------------------------------------------------------------
const mockIsolatePoolExecute = jest.fn();
const mockIsolatePoolSetupSession = jest.fn();
const mockIsolatePoolInvokeHandler = jest.fn();
const mockIsolatePoolTeardownSession = jest.fn();
jest.mock("../../src/services/isolate-pool", () => {
  const MockIsolatePool = jest.fn().mockImplementation(() => ({
    execute: mockIsolatePoolExecute,
    setupSession: mockIsolatePoolSetupSession,
    invokeHandler: mockIsolatePoolInvokeHandler,
    teardownSession: mockIsolatePoolTeardownSession,
    acquire: jest.fn(),
    release: jest.fn(),
    warm: jest.fn(),
    stats: jest.fn().mockReturnValue({ available: 5, inUse: 0, poolSize: 20 }),
  }));
  return { IsolatePool: MockIsolatePool };
});

// ---------------------------------------------------------------------------
// Mock BrowserPool
// ---------------------------------------------------------------------------
const mockBrowserPoolAcquire = jest.fn();
const mockBrowserPoolRelease = jest.fn();
jest.mock("../../src/services/browser-pool", () => {
  const MockBrowserPool = jest.fn().mockImplementation(() => ({
    acquire: mockBrowserPoolAcquire,
    release: mockBrowserPoolRelease,
    initialize: jest.fn().mockResolvedValue(undefined),
    stats: jest.fn().mockReturnValue({ chromiumStatus: "running", activeSessions: 0, poolSize: 40, initialized: true }),
    stop: jest.fn().mockResolvedValue(undefined),
  }));
  return { BrowserPool: MockBrowserPool };
});

// ---------------------------------------------------------------------------
// Mock SessionManager
// ---------------------------------------------------------------------------
const mockSessionManagerCreate = jest.fn();
const mockSessionManagerGet = jest.fn();
const mockSessionManagerTouch = jest.fn();
const mockSessionManagerEnd = jest.fn();
const mockSessionManagerGetInfo = jest.fn();
const mockSessionManagerStats = jest.fn().mockReturnValue({ activeSessions: 0, maxSessions: 40 });
jest.mock("../../src/services/session-manager", () => {
  const MockSessionManager = jest.fn().mockImplementation(() => ({
    create: mockSessionManagerCreate,
    get: mockSessionManagerGet,
    touch: mockSessionManagerTouch,
    end: mockSessionManagerEnd,
    getInfo: mockSessionManagerGetInfo,
    stats: mockSessionManagerStats,
    startSweeper: jest.fn(),
    stopSweeper: jest.fn(),
  }));
  return { SessionManager: MockSessionManager };
});

const { ScriptLoader } = require("../../src/services/script-loader");
const { IsolatePool } = require("../../src/services/isolate-pool");
const { BrowserPool } = require("../../src/services/browser-pool");
const { SessionManager } = require("../../src/services/session-manager");

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (req, res) => {
    res.json({ status: "healthy", uptime: 1, activeSessions: 0, maxSessions: 40, isolatePoolSize: 20, chromiumStatus: "running" });
  });

  const awaRouter = require("../../src/routes/awa");
  app.use("/v1/awa", awaRouter);

  const { AWAError } = require("../../src/utils/errors");
  app.use((err, req, res, _next) => {
    if (err instanceof AWAError) { return res.status(err.httpStatus).json(err.toJSON()); }
    return res.status(500).json({ error: "InternalServerError", details: "An unexpected error occurred." });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: AWA Worker API", () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
    process.env.RATE_LIMIT_DOMAIN = "100";
    process.env.RATE_LIMIT_GLOBAL = "1000";
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => { jest.restoreAllMocks(); });

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe("GET /healthz", () => {
    it("should return 200 with health status", async () => {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.chromiumStatus).toBe("running");
    });
  });

  describe("POST /v1/awa/execute (legacy)", () => {
    it("should return 200 with success for a valid request", async () => {
      mockScriptLoaderFetch.mockResolvedValue('module.exports = { handlers: { async execute() { return { status: "success" }; } } };');
      mockIsolatePoolExecute.mockResolvedValue({ status: "success", checkoutUrl: "https://example.com/checkout", errorDetails: null });
      mockBrowserPoolAcquire.mockResolvedValue({ context: { id: "ctx" }, page: { id: "pg" } });

      const res = await request(app).post("/v1/awa/execute").send({
        domain: "bestbuy.com", sku: "6534211", targetUrl: "https://www.bestbuy.com/site/p/6534211", quantity: 1,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.checkoutUrl).toBe("https://example.com/checkout");
    });

    it("should return 400 when required fields are missing", async () => {
      const res = await request(app).post("/v1/awa/execute").send({ domain: "bestbuy.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
    });

    it("should return 404 when script is not found", async () => {
      mockScriptLoaderFetch.mockResolvedValue(null);

      const res = await request(app).post("/v1/awa/execute").send({
        domain: "unknown.com", sku: "123", targetUrl: "https://unknown.com/p/123",
      });

      expect(res.status).toBe(404);
      expect(res.body.errorDetails).toBe("Script not found");
    });
  });

  describe("POST /v1/awa/session/start", () => {
    it("should create a session successfully", async () => {
      mockScriptLoaderFetchManifest.mockResolvedValue({ domain: "bestbuy.com", capabilities: ["getProduct"] });
      mockScriptLoaderFetch.mockResolvedValue("module.exports = { manifest: { domain: 'bestbuy.com', capabilities: ['getProduct'] }, handlers: { getProduct: async () => ({ title: 'test' }) } };");
      mockBrowserPoolAcquire.mockResolvedValue({ context: { id: "ctx" }, page: { id: "pg" } });
      mockIsolatePoolSetupSession.mockResolvedValue({ isolate: {}, context: {}, global: {}, apiRefs: {}, apiNames: [] });
      mockSessionManagerCreate.mockResolvedValue({ sessionId: "sess_test123", status: "ready", domain: "bestbuy.com", capabilities: ["getProduct"] });

      const res = await request(app).post("/v1/awa/session/start").send({ domain: "bestbuy.com" });

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe("sess_test123");
      expect(res.body.status).toBe("ready");
    });

    it("should return 400 without domain", async () => {
      const res = await request(app).post("/v1/awa/session/start").send({});
      expect(res.status).toBe(400);
    });

    it("should return 503 when browser pool is full", async () => {
      mockScriptLoaderFetchManifest.mockResolvedValue({ domain: "test.com", capabilities: [] });
      mockScriptLoaderFetch.mockResolvedValue("module.exports = { manifest: {}, handlers: {} };");
      mockBrowserPoolAcquire.mockRejectedValue(Object.assign(new Error("busy"), { code: "BROWSER_POOL_FULL" }));

      const res = await request(app).post("/v1/awa/session/start").send({ domain: "test.com" });
      expect(res.status).toBe(503);
    });
  });

  describe("POST /v1/awa/session/:id/action", () => {
    it("should dispatch an action successfully", async () => {
      mockSessionManagerGet.mockReturnValue({
        id: "sess_test", domain: "bestbuy.com", sessionCtx: {}, browserSession: { context: {}, page: {} },
        manifest: { capabilities: ["getProduct"] }, actionsExecuted: 0,
      });
      mockIsolatePoolInvokeHandler.mockResolvedValue({ status: "success", data: { title: "Product" }, errorDetails: null });

      const res = await request(app).post("/v1/awa/session/sess_test/action").send({ action: "getProduct", params: { sku: "123" } });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.title).toBe("Product");
    });

    it("should return 404 for unknown session", async () => {
      mockSessionManagerGet.mockReturnValue(null);
      const res = await request(app).post("/v1/awa/session/sess_unknown/action").send({ action: "getProduct" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/awa/session/:id/end", () => {
    it("should end a session successfully", async () => {
      mockSessionManagerGet.mockReturnValue({
        id: "sess_test", domain: "bestbuy.com", sessionCtx: {}, browserSession: { context: { id: "ctx" }, page: {} },
        manifest: {}, actionsExecuted: 3, createdAt: Date.now() - 60000,
      });
      mockSessionManagerEnd.mockResolvedValue({ createdAt: Date.now() - 60000 });

      const res = await request(app).post("/v1/awa/session/sess_test/end");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("closed");
    });
  });

  describe("Error handling", () => {
    it("should return 500 for unknown errors", async () => {
      const errorApp = express();
      errorApp.use(express.json());
      errorApp.get("/crash", () => { throw new Error("unexpected"); });
      errorApp.use((err, req, res, _next) => res.status(500).json({ error: "InternalServerError", details: "An unexpected error occurred." }));

      const res = await request(errorApp).get("/crash");
      expect(res.status).toBe(500);
    });
  });
});
