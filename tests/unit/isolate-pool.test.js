"use strict";

/**
 * Isolate Pool unit tests.
 *
 * Tests pool lifecycle (acquire/release/stats) with mocked isolated-vm.
 * Full execution tests that require actual V8 isolates are in the integration suite.
 */

jest.mock("isolated-vm", () => {
  let counter = 0;

  function createMockIsolate() {
    const id = ++counter;
    const evalMock = jest.fn().mockResolvedValue(
      JSON.stringify({
        status: "success",
        checkoutUrl: "https://example.com/checkout",
        errorDetails: null,
      }),
    );

    const mockContext = {
      eval: evalMock,
      global: {
        set: jest.fn().mockResolvedValue(undefined),
      },
    };

    return {
      id,
      dispose: jest.fn(),
      createContext: jest.fn().mockResolvedValue(mockContext),
      compileScript: jest.fn().mockResolvedValue({
        run: jest.fn().mockResolvedValue(
          JSON.stringify({
            status: "success",
            checkoutUrl: "https://example.com/checkout",
            errorDetails: null,
          }),
        ),
      }),
    };
  }

  const MockIsolate = jest.fn(createMockIsolate);

  return {
    Isolate: MockIsolate,
    Reference: jest.fn((val) => ({
      get: jest.fn().mockResolvedValue(val),
      set: jest.fn(),
      dispose: jest.fn(),
      _val: val,
    })),
    ExternalCopy: jest.fn(function (val) {
      this._val = val;
      this.copyInto = jest.fn(() => val);
      return this;
    }),
  };
});

describe("IsolatePool", () => {
  let IsolatePool;
  let ivm;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    ivm = require("isolated-vm");
    IsolatePool = require("../../src/services/isolate-pool").IsolatePool;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ivm && ivm.Isolate) {
      ivm.Isolate.mockClear();
    }
  });

  describe("pool lifecycle", () => {
    it("should create a pool with the given size", () => {
      const pool = new IsolatePool({ poolSize: 5 });
      expect(pool.poolSize).toBe(5);
      expect(pool.available).toHaveLength(0);
      expect(pool.inUse.size).toBe(0);
    });

    it("should acquire and return an isolate", async () => {
      const pool = new IsolatePool({ poolSize: 5 });
      const isolate = await pool.acquire();

      expect(isolate).toBeDefined();
      expect(pool.inUse.size).toBe(1);
      expect(pool.available).toHaveLength(0);
    });

    it("should release an isolate back to the pool", async () => {
      const pool = new IsolatePool({ poolSize: 5 });
      const isolate = await pool.acquire();
      pool.release(isolate);

      expect(pool.inUse.size).toBe(0);
      expect(pool.available).toHaveLength(1);
    });

    it("should re-use released isolates", async () => {
      const pool = new IsolatePool({ poolSize: 5 });

      const iso1 = await pool.acquire();
      pool.release(iso1);

      const iso2 = await pool.acquire();
      expect(iso2).toBe(iso1); // Same isolate re-used
    });

    it("should destroy isolates when pool has no space", async () => {
      const pool = new IsolatePool({ poolSize: 0 });

      const isolate = await pool.acquire();
      expect(pool.inUse.size).toBe(1);
      expect(pool.available).toHaveLength(0);

      // Force-check that _destroyIsolate is called by spying on it
      const destroySpy = jest.spyOn(pool, "_destroyIsolate");

      pool.release(isolate);

      expect(pool.inUse.size).toBe(0);
      expect(pool.available).toHaveLength(0);
      expect(destroySpy).toHaveBeenCalledWith(isolate);
      expect(isolate.dispose).toHaveBeenCalled();
    });

    it("should report correct stats", async () => {
      const pool = new IsolatePool({ poolSize: 10 });
      const stats = pool.stats();

      expect(stats.poolSize).toBe(10);
      expect(stats.available).toBe(0);
      expect(stats.inUse).toBe(0);

      await pool.acquire();
      const stats2 = pool.stats();
      expect(stats2.inUse).toBe(1);
    });

    it("should stop and destroy all isolates", async () => {
      const pool = new IsolatePool({ poolSize: 5 });

      const iso1 = await pool.acquire();
      const iso2 = await pool.acquire();
      pool.release(iso1);
      // iso2 still in use

      await pool.stop();

      expect(pool.available).toHaveLength(0);
      expect(pool.inUse.size).toBe(0);
      expect(pool.stopped).toBe(true);
    });

    it("should throw when acquiring from a stopped pool", async () => {
      const pool = new IsolatePool({ poolSize: 5 });
      await pool.stop();
      await expect(pool.acquire()).rejects.toThrow("stopped");
    });
  });

  describe("warm", () => {
    it("should pre-warm isolates up to 5", async () => {
      const pool = new IsolatePool({ poolSize: 10 });
      pool.warm();

      // Wait for warm to complete
      await pool._warmPromise;

      expect(pool.available.length).toBeGreaterThanOrEqual(1);
      expect(pool.available.length).toBeLessThanOrEqual(5);
    });

    it("should not warm twice", async () => {
      const pool = new IsolatePool({ poolSize: 10 });
      pool.warm();
      const p1 = pool._warmPromise;
      pool.warm();
      expect(pool._warmPromise).toBe(p1);
    });
  });

  describe("execute", () => {
    it("should return failed result if script fails screening", async () => {
      const pool = new IsolatePool({ poolSize: 5 });
      const result = await pool.execute({
        domain: "test.com",
        scriptSource: "const process = 1; async function execute() {}",
        page: {},
        params: {
          targetUrl: "https://example.com",
          sku: "123",
          quantity: 1,
          options: {},
        },
      });

      expect(result.status).toBe("failed");
      expect(result.errorDetails).toContain("process");
    });

    it("should return failed result if isolate cannot be acquired", async () => {
      const pool = new IsolatePool({ poolSize: 5 });
      // Make acquire throw
      jest.spyOn(pool, "acquire").mockRejectedValue(new Error("pool error"));

      const result = await pool.execute({
        domain: "test.com",
        scriptSource:
          "module.exports = { handlers: { async execute() { return { status: 'success' }; } } };",
        page: {},
        params: {
          targetUrl: "https://example.com",
          sku: "123",
          quantity: 1,
          options: {},
        },
      });

      expect(result.status).toBe("failed");
      expect(result.errorDetails).toContain("pool error");
    });
  });
});
