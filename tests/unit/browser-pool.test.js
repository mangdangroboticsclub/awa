"use strict";

/**
 * Browser Pool unit tests.
 *
 * Tests pool management (acquire/release/stats) with Playwright mocked.
 */

jest.mock("playwright-extra", () => {
  let contextCounter = 0;

  function createMockContext() {
    const id = ++contextCounter;
    return {
      id,
      clearCookies: jest.fn().mockResolvedValue(undefined),
      clearPermissions: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue({
        id: `mock-page-${id}`,
        addInitScript: jest.fn().mockResolvedValue(undefined),
      }),
    };
  }

  return {
    chromium: {
      use: jest.fn(),
      launch: jest.fn().mockResolvedValue({
        newContext: jest.fn(createMockContext),
        close: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }),
    },
  };
});

jest.mock("puppeteer-extra-plugin-stealth", () => jest.fn(() => ({ name: "stealth" })));

jest.mock("../../src/services/proxy-router", () => ({
  getBrowserLaunchOptions: jest.fn(() => ({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  })),
  getContextProxyConfig: jest.fn(() => null),
}));

const { chromium } = require("playwright-extra");
const { BrowserPool } = require("../../src/services/browser-pool");

describe("BrowserPool", () => {
  let pool;

  beforeEach(() => {
    jest.clearAllMocks();
    pool = new BrowserPool({ poolSize: 5 });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      await pool.stop();
    } catch (_) {}
  });

  describe("initialization", () => {
    it("should start with stopped status", () => {
      expect(pool.stats().chromiumStatus).toBe("stopped");
      expect(pool.stats().initialized).toBe(false);
    });

    it("should launch Chromium on initialize()", async () => {
      await pool.initialize();

      expect(chromium.use).toHaveBeenCalled();
      expect(chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          executablePath: "/usr/bin/chromium",
          headless: true,
        }),
      );
      expect(pool.stats().chromiumStatus).toBe("running");
      expect(pool.stats().initialized).toBe(true);
    });

    it("should not initialize twice", async () => {
      await pool.initialize();

      await pool.initialize();
      // Should be the same browser instance — launch only called once
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });
  });

  describe("acquire / release", () => {
    beforeEach(async () => {
      await pool.initialize();
    });

    it("should acquire a context and page", async () => {
      const { context, page } = await pool.acquire("bestbuy.com");

      expect(context).toBeDefined();
      expect(page).toBeDefined();
      expect(pool.stats().activeSessions).toBe(1);
    });

    it("should release a context and clear state", async () => {
      const { context } = await pool.acquire("bestbuy.com");
      expect(pool.stats().activeSessions).toBe(1);

      await pool.release(context);
      expect(pool.stats().activeSessions).toBe(0);

      // State elimination was called
      expect(context.clearCookies).toHaveBeenCalled();
      expect(context.clearPermissions).toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
    });

    it("should track multiple concurrent sessions", async () => {
      const s1 = await pool.acquire("domain-a.com");
      const s2 = await pool.acquire("domain-b.com");
      const s3 = await pool.acquire("domain-c.com");

      expect(pool.stats().activeSessions).toBe(3);

      await pool.release(s1.context);
      expect(pool.stats().activeSessions).toBe(2);

      await pool.release(s2.context);
      await pool.release(s3.context);
      expect(pool.stats().activeSessions).toBe(0);
    });

    it("should throw when pool is full", async () => {
      const pool2 = new BrowserPool({ poolSize: 2 });
      await pool2.initialize();

      await pool2.acquire("a.com");
      await pool2.acquire("b.com");

      await expect(pool2.acquire("c.com")).rejects.toThrow("busy");
      await pool2.stop();
    });

    it("should silently handle release of unknown context", async () => {
      // Should not throw
      await pool.release({ id: "unknown" });
      expect(pool.stats().activeSessions).toBe(0);
    });
  });

  describe("stats", () => {
    beforeEach(async () => {
      await pool.initialize();
    });

    it("should report pool size from constructor", () => {
      const stats = pool.stats();
      expect(stats.poolSize).toBe(5);
    });

    it("should report running chromium status after init", () => {
      expect(pool.stats().chromiumStatus).toBe("running");
    });
  });

  describe("stop", () => {
    it("should close all active contexts and the browser", async () => {
      await pool.initialize();
      await pool.acquire("a.com");
      await pool.acquire("b.com");

      await pool.stop();

      expect(pool.stats().chromiumStatus).toBe("stopped");
      expect(pool.stats().activeSessions).toBe(0);
      expect(pool.browser).toBeNull();
    });
  });
});
