"use strict";

/**
 * Rate limiting middleware.
 *
 * Implements three tiers of rate limiting as specified in API.md §3:
 * - Per domain: max requests per domain per minute
 * - Per IP: max requests per caller IP per minute
 * - Global: max total requests per minute
 *
 * Uses an in-memory sliding window counter. In production, this should
 * be replaced with a distributed store (Redis, etc.) for multi-instance accuracy.
 *
 * In local development, limits are relaxed (see LOCAL_AWA_SETUP.md §11.1).
 */

const logger = require("../utils/logger");
const { RateLimitedError } = require("../utils/errors");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
  domain: {
    limit: parseInt(process.env.RATE_LIMIT_DOMAIN, 10) || 10,
    windowMs: 60_000,
  },
  ip: {
    limit: 100,
    windowMs: 60_000,
  },
  global: {
    limit: parseInt(process.env.RATE_LIMIT_GLOBAL, 10) || 500,
    windowMs: 60_000,
  },
};

// ---------------------------------------------------------------------------
// In-memory sliding window store
// ---------------------------------------------------------------------------

class SlidingWindowStore {
  constructor() {
    // Map<key, Array<timestamp>>
    this.windows = new Map();
  }

  /**
   * Prune expired entries and check if the key is within limit.
   * Returns { allowed, remaining, resetMs }.
   */
  check(key, limit, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;

    let entries = this.windows.get(key);
    if (!entries) {
      entries = [];
      this.windows.set(key, entries);
    }

    // Remove expired timestamps
    while (entries.length > 0 && entries[0] < cutoff) {
      entries.shift();
    }

    const remaining = Math.max(0, limit - entries.length);
    const allowed = entries.length < limit;

    // Calculate when the window resets (oldest entry + windowMs, or now + windowMs if empty)
    const resetMs = entries.length > 0 ? entries[0] + windowMs : now + windowMs;

    return { allowed, remaining, resetMs };
  }

  /** Record a hit for the given key. */
  hit(key) {
    const entries = this.windows.get(key);
    if (entries) {
      entries.push(Date.now());
    }
  }

  /** Periodic cleanup of stale keys. */
  cleanup() {
    const now = Date.now();
    for (const [key, entries] of this.windows.entries()) {
      // Remove keys with all expired entries
      if (
        entries.length === 0 ||
        entries[entries.length - 1] < now - config.global.windowMs * 2
      ) {
        this.windows.delete(key);
      }
    }
  }
}

const store = new SlidingWindowStore();

// Run cleanup every 5 minutes (unref so it doesn't keep the process alive)
setInterval(() => store.cleanup(), 300_000).unref();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Rate limiting middleware.
 *
 * Checks three tiers in order: global → per-IP → per-domain.
 * Sets X-RateLimit-* headers on the response.
 * Returns 429 with RateLimitedError if any limit is exceeded.
 */
function rateLimitMiddleware(req, res, next) {
  const domain = req.body?.domain || "unknown";
  const ip = req.ip || req.connection.remoteAddress || "unknown";

  // 1. Global limit check
  const globalCheck = store.check(
    "__global__",
    config.global.limit,
    config.global.windowMs,
  );
  if (!globalCheck.allowed) {
    logger.warn("Rate limit exceeded (global)", { ip, domain });
    return next(new RateLimitedError(5));
  }

  // 2. Per-IP limit check
  const ipCheck = store.check(`ip:${ip}`, config.ip.limit, config.ip.windowMs);
  if (!ipCheck.allowed) {
    logger.warn("Rate limit exceeded (IP)", { ip, domain });
    return next(new RateLimitedError(5));
  }

  // 3. Per-domain limit check
  const domainCheck = store.check(
    `domain:${domain}`,
    config.domain.limit,
    config.domain.windowMs,
  );
  if (!domainCheck.allowed) {
    logger.warn("Rate limit exceeded (domain)", { ip, domain });
    return next(new RateLimitedError(5));
  }

  // Record the hit
  store.hit("__global__");
  store.hit(`ip:${ip}`);
  store.hit(`domain:${domain}`);

  // Set rate limit headers
  const remaining = Math.min(
    globalCheck.remaining,
    ipCheck.remaining,
    domainCheck.remaining,
  );
  const resetMs = Math.max(
    globalCheck.resetMs,
    ipCheck.resetMs,
    domainCheck.resetMs,
  );

  res.setHeader("X-RateLimit-Limit", config.domain.limit);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining - 1));
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetMs / 1000));

  next();
}

module.exports = { rateLimitMiddleware };
