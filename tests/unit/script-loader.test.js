"use strict";

const { LRUCache } = require("../../src/services/script-loader");

describe("LRUCache", () => {
  let cache;

  beforeEach(() => {
    cache = new LRUCache(3, 5000); // max 3 items, 5s TTL
  });

  it("should return null for missing keys", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("should store and retrieve values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("should evict oldest entries when at capacity", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // 'a' should be evicted

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
    expect(cache.size).toBe(3);
  });

  it("should promote accessed entries to most-recently-used", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Access 'a' — promotes it to MRU
    cache.get("a");

    // Now add 'd' — 'b' should be evicted (oldest)
    cache.set("d", "4");

    expect(cache.get("a")).toBe("1"); // Still there (promoted)
    expect(cache.get("b")).toBeNull(); // Evicted
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("should expire entries after TTL", () => {
    jest.useFakeTimers();

    cache = new LRUCache(100, 1000); // 1s TTL
    cache.set("key", "value");

    // Before TTL
    expect(cache.get("key")).toBe("value");

    // After TTL
    jest.advanceTimersByTime(1001);
    expect(cache.get("key")).toBeNull();

    jest.useRealTimers();
  });

  it("should clear all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
  });
});

describe("ScriptLoader", () => {
  let ScriptLoader;

  beforeEach(() => {
    jest.resetModules();
    ScriptLoader = require("../../src/services/script-loader").ScriptLoader;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("local filesystem fallback", () => {
    it("should initialize with local fallback without GCS client", async () => {
      const loader = new ScriptLoader({
        useLocalFallback: true,
        localBasePath: "/workspace/data/gcs",
        bucket: "awa-skills-dev",
      });

      await loader.initialize();
      expect(loader.initialized).toBe(true);
      expect(loader.storage).toBeNull();
    });

    it("should return null for a non-existent domain", async () => {
      const loader = new ScriptLoader({
        useLocalFallback: true,
        localBasePath: "/workspace/data/gcs",
        bucket: "awa-skills-dev",
      });

      await loader.initialize();
      const source = await loader.fetch("nonexistent-domain.com");
      expect(source).toBeNull();
    });

    it("should return script source for an existing file", async () => {
      const fs = require("fs");
      const path = require("path");
      const tmpDir = fs.mkdtempSync("/tmp/awa-test-");
      const testDir = path.join(tmpDir, "awa-skills-dev", "user-scripts", "testshop.com");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "skill.js"),
        "async function execute() { return { status: 'success' }; }",
      );

      const loader = new ScriptLoader({
        useLocalFallback: true,
        localBasePath: tmpDir,
        bucket: "awa-skills-dev",
      });

      await loader.initialize();
      const source = await loader.fetch("testshop.com");
      expect(source).toContain("execute");
      expect(source).toContain("success");

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("cache behavior", () => {
    it("should cache fetched scripts and return cached version", async () => {
      const loader = new ScriptLoader({
        useLocalFallback: true,
        localBasePath: "/workspace/data/gcs",
        bucket: "awa-skills-dev",
        cacheTtlMs: 60000,
      });

      await loader.initialize();

      // Mock _readLocalFile to count calls
      const mockFetch = jest
        .spyOn(loader, "_readLocalFile")
        .mockResolvedValue("async function execute() { return { status: 'success' }; }");

      // First call — should hit _readLocalFile
      const first = await loader.fetch("cachedomain.com");
      expect(first).toContain("success");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      const second = await loader.fetch("cachedomain.com");
      expect(second).toContain("success");
      expect(mockFetch).toHaveBeenCalledTimes(1); // Not called again

      mockFetch.mockRestore();
    });

    it("should clear cache on clearCache()", async () => {
      const loader = new ScriptLoader({
        useLocalFallback: true,
        localBasePath: "/workspace/data/gcs",
        bucket: "awa-skills-dev",
      });

      await loader.initialize();

      const mockFetch = jest
        .spyOn(loader, "_readLocalFile")
        .mockResolvedValue("async function execute() { return { status: 'success' }; }");

      await loader.fetch("clearme.com");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      loader.clearCache();

      await loader.fetch("clearme.com");
      expect(mockFetch).toHaveBeenCalledTimes(2); // Called again after clear

      mockFetch.mockRestore();
    });
  });
});
