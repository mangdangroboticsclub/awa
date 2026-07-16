"use strict";

/**
 * OpenClaw AWA Worker — Express Server Entry Point
 *
 * Initializes the Express application, mounts middleware,
 * registers routes, and starts the HTTP server.
 *
 * See:
 *   - ARCHITECTURE.md §2 — Component architecture
 *   - API.md §1 — Endpoints
 *   - SDD.md §2.1 — Cloud Run Core Worker Host
 *   - DEVELOPMENT.md §4 — Local development setup
 */

require("dotenv").config();

const express = require("express");
const logger = require("./utils/logger");
const { AWAError } = require("./utils/errors");
const awaRouter = require("./routes/awa");
const { BrowserPool } = require("./services/browser-pool");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 8080;

// ---------------------------------------------------------------------------
// Singleton services
// ---------------------------------------------------------------------------

let browserPool = null;

function getBrowserPool() {
  if (!browserPool) {
    browserPool = new BrowserPool();
  }
  return browserPool;
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();

// --- Body parsing ---
app.use(express.json({ limit: "1mb" }));

// --- Request logging ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.debug("HTTP request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
    });
  });
  next();
});

// ---------------------------------------------------------------------------
// Health Check — GET /healthz
// ---------------------------------------------------------------------------
// Used by Cloud Run for startup and liveness probes.
// See API.md §4 for the response schema.

app.get("/healthz", (req, res) => {
  const pool = getBrowserPool();
  const poolStats = pool.stats();
  const sm = awaRouter._getSessionManager?.();
  const sessionStats = sm ? sm.stats() : { activeSessions: 0, maxSessions: 40 };

  res.json({
    status: poolStats.chromiumStatus === "running" ? "healthy" : "degraded",
    uptime: Math.floor(process.uptime()),
    activeSessions: sessionStats.activeSessions,
    maxSessions: sessionStats.maxSessions,
    isolatePoolSize: parseInt(process.env.ISOLATE_POOL_SIZE, 10) || 20,
    chromiumStatus: poolStats.chromiumStatus,
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use("/v1/awa", awaRouter);

// ---------------------------------------------------------------------------
// Global Error Handler
// ---------------------------------------------------------------------------

app.use((err, req, res, _next) => {
  // Known application errors
  if (err instanceof AWAError) {
    logger.warn("Application error", {
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
    });
    return res.status(err.httpStatus).json(err.toJSON());
  }

  // Unknown / unexpected errors
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  });

  return res.status(500).json({
    error: "InternalServerError",
    details: "An unexpected error occurred.",
  });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  logger.info("AWA Worker server started", {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || "development",
    isolatePoolSize: parseInt(process.env.ISOLATE_POOL_SIZE, 10) || 20,
    browserPoolSize: parseInt(process.env.BROWSER_POOL_SIZE, 10) || 40,
    proxyMode: process.env.PROXY_MODE || "none",
  });

  // Pre-warm the browser pool (non-blocking)
  const pool = getBrowserPool();
  pool.initialize().catch((err) => {
    logger.error("Failed to initialize browser pool on startup", {
      error: err.message,
    });
  });
});

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Stop the session manager sweeper
  const sessionManager = awaRouter._getSessionManager?.();
  if (sessionManager) {
    sessionManager.stopSweeper();
  }

  // Stop the browser pool
  if (browserPool) {
    try {
      await browserPool.stop();
    } catch (err) {
      logger.error("Error stopping browser pool", { error: err.message });
    }
  }

  // Stop the isolate pool (if accessible via route)
  const isolatePool = awaRouter._getIsolatePool?.();
  if (isolatePool) {
    try {
      await isolatePool.stop();
    } catch (err) {
      logger.error("Error stopping isolate pool", { error: err.message });
    }
  }

  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });

  // Force exit after 10s grace period
  setTimeout(() => {
    logger.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = app;
