"use strict";

/**
 * AWA Session Routes — Session lifecycle + action dispatch
 *
 * Endpoints:
 *   POST /v1/awa/session/start       — Create session (isolate + page)
 *   POST /v1/awa/session/:id/action  — Dispatch action to session
 *   POST /v1/awa/session/:id/end     — End session (cleanup)
 *   GET  /v1/awa/session/:id         — Get session status
 *
 * See API.md v2.0.0 for full contract.
 */

const express = require("express");
const logger = require("../utils/logger");
const { validateRequest } = require("../middleware/validation");
const { authMiddleware } = require("../middleware/auth");
const { rateLimitMiddleware } = require("../middleware/rate-limit");
const { ScriptLoader } = require("../services/script-loader");
const { IsolatePool } = require("../services/isolate-pool");
const { BrowserPool } = require("../services/browser-pool");
const { SessionManager } = require("../services/session-manager");

const router = express.Router();

// ---------------------------------------------------------------------------
// Core Gateway URL (for skill enablement checks)
// ---------------------------------------------------------------------------

const CORE_GATEWAY_URL = process.env.CORE_GATEWAY_URL || "http://gcp-cloudrun-core-gateway:8080";

async function checkSkillEnabled(robotUuid, skillId) {
  /** Verify this skill is enabled for this robot via the core_gateway API. */
  try {
    const resp = await fetch(
      `${CORE_GATEWAY_URL}/v1/robots/${encodeURIComponent(robotUuid)}/skills`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return false;
    const skills = await resp.json();
    return skills.some((s) => s.skill_id === skillId && s.enabled === true);
  } catch (err) {
    logger.warn("Failed to check skill enablement", { robotUuid, skillId, error: err.message });
    return false; // deny on error (fail closed)
  }
}

// -------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let scriptLoader = null;
let isolatePool = null;
let browserPool = null;
let sessionManager = null;

function getScriptLoader() {
  if (!scriptLoader) { scriptLoader = new ScriptLoader(); scriptLoader.initialize().catch((err) => logger.error("Failed to init script loader", { error: err.message })); }
  return scriptLoader;
}
function getIsolatePool() {
  if (!isolatePool) { isolatePool = new IsolatePool(); isolatePool.warm(); }
  return isolatePool;
}
function getBrowserPool() {
  if (!browserPool) { browserPool = new BrowserPool(); }
  return browserPool;
}
function getSessionManager() {
  if (!sessionManager) {
    sessionManager = new SessionManager();
    sessionManager.startSweeper(getIsolatePool(), getBrowserPool());
  }
  return sessionManager;
}

router._getBrowserPool = getBrowserPool;
router._getIsolatePool = getIsolatePool;
router._getSessionManager = getSessionManager;

// ---------------------------------------------------------------------------
// Middleware: resolve session
// ---------------------------------------------------------------------------

async function resolveSession(req, res, next) {
  const sm = getSessionManager();
  const session = sm.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "SessionNotFound", details: `Session ${req.params.sessionId} not found or expired` });
  }
  req.session = session;
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /v1/awa/session/start
 * Create a new session for a merchant domain.
 */
router.post(
  "/session/start",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    const { skill_id, version, capabilities, robot_uuid } = req.body;

    if (!skill_id || typeof skill_id !== "string") {
      return res.status(400).json({ error: "ValidationError", details: "Field 'skill_id' is required" });
    }
    if (!version || typeof version !== "string") {
      return res.status(400).json({ error: "ValidationError", details: "Field 'version' is required (e.g. 'v2.5.0')" });
    }
    if (!robot_uuid || typeof robot_uuid !== "string") {
      return res.status(400).json({ error: "ValidationError", details: "Field 'robot_uuid' is required" });
    }

    const log = logger.child({ skill_id, version, robot_uuid });
    log.info("Starting AWA session");

    try {
      // 0. Verify the skill is enabled for this robot
      const isEnabled = await checkSkillEnabled(robot_uuid, skill_id);
      if (!isEnabled) {
        log.warn("Skill not enabled for robot — denying session start");
        return res.status(403).json({
          error: "SkillNotEnabled",
          details: `Skill '${skill_id}' is not enabled for robot '${robot_uuid}'. Enable it first via the marketplace.`,
        });
      }

      // 1. Load skill manifest + script
      const loader = getScriptLoader();
      const manifest = await loader.fetchManifest(skill_id, version);
      if (!manifest) {
        return res.status(404).json({ error: "SkillNotFound", details: `No manifest found for skill: ${skill_id} version: ${version}` });
      }

      const scriptSource = await loader.fetchScript(skill_id, version);
      if (!scriptSource) {
        return res.status(404).json({ error: "SkillNotFound", details: `No skill script found for skill: ${skill_id} version: ${version}` });
      }

      // 2. Validate requested capabilities (if specified)
      if (capabilities && Array.isArray(capabilities)) {
        const supported = manifest.capabilities || [];
        const missing = capabilities.filter((c) => !supported.includes(c));
        if (missing.length > 0) {
          return res.status(422).json({ error: "CapabilityNotSupported", details: `Capabilities not in manifest: ${missing.join(", ")}` });
        }
      }

      // 3. Acquire browser page
      const bPool = getBrowserPool();
      const browserSession = await bPool.acquire(skill_id);

      // 4. Setup isolate with skill
      const iPool = getIsolatePool();
      const sessionCtx = await iPool.setupSession({
        scriptSource,
        page: browserSession.page,
        manifest,
      });

      // 5. Register session
      const sm = getSessionManager();
      const sessionInfo = await sm.create({ sessionCtx, browserSession, manifest, domain: skill_id, robotUuid: robot_uuid });

      log.info("Session started", { sessionId: sessionInfo.sessionId, skill_id, version, capabilities: manifest.capabilities });
      return res.json(sessionInfo);
    } catch (err) {
      if (err.code === "SESSION_LIMIT_REACHED" || err.code === "BROWSER_POOL_FULL") {
        return res.status(503).json({ error: "Overloaded", details: err.message });
      }
      log.error("Failed to start session", { error: err.message });
      return next(err);
    }
  },
);

/**
 * POST /v1/awa/session/:sessionId/action
 * Dispatch an action to an active session.
 */
router.post(
  "/session/:sessionId/action",
  authMiddleware,
  resolveSession,
  async (req, res, next) => {
    const { action, params } = req.body;
    const session = req.session;

    if (!action || typeof action !== "string") {
      return res.status(400).json({ error: "ValidationError", details: "Field 'action' is required" });
    }

    const log = logger.child({ sessionId: session.id, domain: session.domain, action });

    try {
      log.debug("Dispatching action", { params });

      const iPool = getIsolatePool();
      const result = await iPool.invokeHandler(session.sessionCtx, action, params || {});

      // Touch the session (extends idle timeout)
      getSessionManager().touch(session.id);

      // ╔══════════════════════════════════════════════════════════════════╗
      // ║  Bot detection warning                                          ║
      // ║  When a skill returns status="blocked", the merchant site has    ║
      // ║  detected automated access and blocked the request. This is      ║
      // ║  most common with Amazon.com without a residential proxy.        ║
      // ╚══════════════════════════════════════════════════════════════════╝
      if (result.status === "blocked") {
        var detectionTypes = result.data && result.data.detection
          ? (Array.isArray(result.data.detection) ? result.data.detection.join(", ") : result.data.detection)
          : "unknown";
        var blockedBy = result.data && result.data.blockedBy
          ? result.data.blockedBy
          : session.domain;

        log.warn("🚨 Bot detection — blocking", {
          sessionId: session.id,
          domain: session.domain,
          action: action,
          detectedBy: blockedBy,
          detectionTypes: detectionTypes,
          query: result.data && result.data.query,
          bodySnippet: result.data && result.data.bodySnippet,
          pageUrl: result.data && result.data.pageUrl,
        });
      }

      log.info("Action completed", { status: result.status });

      // Add a _warning field to blocked responses so callers can surface it
      var responsePayload = {
        status: result.status,
        data: result.data,
        errorDetails: result.errorDetails,
        sessionId: session.id,
      };

      if (result.status === "blocked" && session.domain === "amazon.com") {
        responsePayload._warning = {
          type: "BOT_DETECTION",
          message: "Amazon blocked this request — likely due to missing or insufficient proxy configuration. " +
            "Configure PROXY_MODE=residential with a rotating residential proxy provider to proceed.",
          details: "See proxy-router.js for setup instructions and recommended providers.",
          detection: result.data && result.data.detection ? result.data.detection : [],
        };
      }

      return res.json(responsePayload);
    } catch (err) {
      log.error("Action failed", { error: err.message });
      return next(err);
    }
  },
);

/**
 * POST /v1/awa/session/:sessionId/end
 * End a session and release all resources.
 */
router.post(
  "/session/:sessionId/end",
  authMiddleware,
  resolveSession,
  async (req, res, next) => {
    const session = req.session;
    const log = logger.child({ sessionId: session.id, domain: session.domain });

    try {
      // Tear down isolate
      const iPool = getIsolatePool();
      await iPool.teardownSession(session.sessionCtx);

      // Release browser
      const bPool = getBrowserPool();
      await bPool.release(session.browserSession.context);

      // Remove from manager
      const sm = getSessionManager();
      const ended = await sm.end(session.id);

      log.info("Session ended");
      return res.json({
        status: "closed",
        sessionId: session.id,
        duration: Math.floor((Date.now() - ended.createdAt) / 1000),
      });
    } catch (err) {
      log.error("Error ending session", { error: err.message });
      return next(err);
    }
  },
);

/**
 * GET /v1/awa/session/:sessionId
 * Get session status.
 */
router.get(
  "/session/:sessionId",
  authMiddleware,
  resolveSession,
  (req, res) => {
    const sm = getSessionManager();
    const info = sm.getInfo(req.session.id);
    res.json(info);
  },
);

// ---------------------------------------------------------------------------
// Legacy POST /v1/awa/execute — kept for backward compatibility
// ---------------------------------------------------------------------------

router.post(
  "/execute",
  authMiddleware,
  rateLimitMiddleware,
  async (req, res, next) => {
    const { skill_id, version, sku, targetUrl, quantity, options } = req.body;
    if (!skill_id || !version || !sku || !targetUrl) {
      return res.status(400).json({ error: "ValidationError", details: "skill_id, version, sku, and targetUrl are required" });
    }

    const log = logger.child({ skill_id, version, sku });

    try {
      // Load script
      const loader = getScriptLoader();
      const scriptSource = await loader.fetchScript(skill_id, version);
      if (!scriptSource) {
        return res.status(404).json({ status: "failed", checkoutUrl: null, errorDetails: "Script not found" });
      }

      // Acquire browser
      const bPool = getBrowserPool();
      const browserSession = await bPool.acquire(skill_id);

      try {
        const iPool = getIsolatePool();
        const result = await iPool.execute({
          domain: skill_id,
          scriptSource,
          page: browserSession.page,
          params: { targetUrl, sku, quantity, options },
        });
        return res.json(result);
      } finally {
        await bPool.release(browserSession.context);
      }
    } catch (err) {
      log.error("AWA execution failed", { error: err.message });
      return next(err);
    }
  },
);

module.exports = router;
