"use strict";

const { Storage } = require("@google-cloud/storage");
const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

class LRUCache {
  constructor(maxSize = 100, ttlMs = 300_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear() { this.cache.clear(); }
  get size() { return this.cache.size; }
}

// ---------------------------------------------------------------------------
// Script Loader — fetches both manifest.json and skill.js per domain
// ---------------------------------------------------------------------------

class ScriptLoader {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.GCS_ENDPOINT;
    this.bucketName = options.bucket || process.env.GCS_BUCKET || "awa-skills-dev";
    this.projectId = options.projectId || process.env.GCS_PROJECT_ID || "openclaw-dev";
    this.useLocalFallback = options.useLocalFallback || false;
    this.localBasePath = options.localBasePath || process.env.GCS_LOCAL_PATH || "/workspace/data/gcs";

    // Separate caches for manifest and script
    this._cache = new LRUCache(options.cacheMaxSize || 100, options.cacheTtlMs || 300_000);

    this.storage = null;
    this.bucket = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.useLocalFallback) {
      this.initialized = true;
      logger.info("ScriptLoader: using local filesystem fallback", { basePath: this.localBasePath });
      return;
    }
    const opts = { projectId: this.projectId };
    if (this.endpoint) {
      opts.apiEndpoint = this.endpoint;
      logger.info("ScriptLoader: using GCS emulator", { endpoint: this.endpoint, bucket: this.bucketName });
    } else {
      logger.info("ScriptLoader: using real GCS", { bucket: this.bucketName });
    }
    this.storage = new Storage(opts);
    this.bucket = this.storage.bucket(this.bucketName);
    this.initialized = true;
  }

  /** Cache key helpers */
  _manifestKey(domain) { return `manifest:${domain}`; }
  _scriptKey(domain) { return `script:${domain}`; }

  /**
   * Fetch the skill manifest for a domain.
   * Path: user-scripts/<domain>/manifest.json
   */
  async fetchManifest(domain) {
    const key = this._manifestKey(domain);
    const cached = this._cache.get(key);
    if (cached) { logger.debug("ScriptLoader: manifest cache hit", { domain }); return cached; }

    logger.debug("ScriptLoader: fetching manifest", { domain });
    try {
      let data;
      if (this.useLocalFallback) {
        data = await this._readLocalFile(domain, "manifest.json");
      } else {
        data = await this._readGCSFile(domain, "manifest.json");
      }
      if (data) {
        const parsed = JSON.parse(data);
        this._cache.set(key, parsed);
        return parsed;
      }
      return null;
    } catch (err) {
      logger.error("ScriptLoader: failed to fetch manifest", { domain, error: err.message });
      return null;
    }
  }

  /**
   * Fetch the skill script source for a domain.
   * Path: user-scripts/<domain>/skill.js
   */
  async fetchScript(domain) {
    const key = this._scriptKey(domain);
    const cached = this._cache.get(key);
    if (cached) { logger.debug("ScriptLoader: script cache hit", { domain }); return cached; }

    logger.debug("ScriptLoader: fetching script", { domain });
    try {
      let source;
      if (this.useLocalFallback) {
        source = await this._readLocalFile(domain, "skill.js");
      } else {
        source = await this._readGCSFile(domain, "skill.js");
      }
      if (source) {
        this._cache.set(key, source);
        logger.debug("ScriptLoader: script loaded and cached", { domain, size: source.length });
      }
      return source;
    } catch (err) {
      logger.error("ScriptLoader: failed to fetch script", { domain, error: err.message });
      return null;
    }
  }

  /** Backward-compatible alias */
  async fetch(domain) { return this.fetchScript(domain); }

  async _readLocalFile(domain, filename) {
    const fs = require("fs");
    const path = require("path");
    const filePath = path.join(this.localBasePath, this.bucketName, "user-scripts", domain, filename);
    try {
      return await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.debug("ScriptLoader: local file not found", { domain, file: filename, path: filePath });
        return null;
      }
      throw err;
    }
  }

  async _readGCSFile(domain, filename) {
    const objectKey = `user-scripts/${domain}/${filename}`;
    try {
      const [contents] = await this.bucket.file(objectKey).download();
      return contents.toString("utf-8");
    } catch (err) {
      if (err.code === 404) {
        logger.debug("ScriptLoader: GCS file not found", { domain, key: objectKey });
        return null;
      }
      throw err;
    }
  }

  clearCache() { this._cache.clear(); }
}

module.exports = { ScriptLoader, LRUCache };
