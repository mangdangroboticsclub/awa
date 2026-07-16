"use strict";

/**
 * Session Manager — Manages active AWA sessions.
 *
 * Each session holds:
 *   - A V8 isolate context (from IsolatePool.setupSession)
 *   - A Playwright BrowserContext and Page (from BrowserPool)
 *   - The skill manifest and handlers
 *
 * Sessions are long-lived — they persist across multiple action invocations
 * until explicitly ended by OpenClaw or terminated by idle timeout (15 min).
 */

const { v4: uuidv4 } = require("uuid");
const logger = require("../utils/logger");

const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS, 10) || 15 * 60 * 1000; // 15 min
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS, 10) || 40;

class SessionManager {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this._sweeperInterval = null;
  }

  /**
   * Create a new session.
   *
   * @param {object} resources
   * @param {object} resources.sessionCtx - Isolate session context
   * @param {object} resources.browserSession - { context, page } from BrowserPool
   * @param {object} resources.manifest - Skill manifest
   * @param {string} resources.domain - Merchant domain
   * @returns {object} Session info object
   */
  async create({ sessionCtx, browserSession, manifest, domain }) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error("All worker slots are busy. Retry later."), {
        code: "SESSION_LIMIT_REACHED",
      });
    }

    const sessionId = "sess_" + uuidv4().replace(/-/g, "").slice(0, 12);
    const now = Date.now();

    const session = {
      id: sessionId,
      domain,
      manifest,
      sessionCtx,
      browserSession,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + SESSION_IDLE_TIMEOUT_MS,
      actionsExecuted: 0,
    };

    this.sessions.set(sessionId, session);
    logger.info("SessionManager: session created", {
      sessionId,
      domain,
      capabilities: manifest?.capabilities?.length || 0,
      activeCount: this.sessions.size,
    });

    return this._toInfo(session);
  }

  /**
   * Get a session by ID.
   * Returns null if not found or expired.
   */
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // Check expiry
    if (Date.now() > session.expiresAt) {
      logger.debug("SessionManager: session expired", { sessionId });
      return null;
    }

    return session;
  }

  /**
   * Touch a session (update lastActivityAt and expiresAt).
   */
  touch(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.lastActivityAt = Date.now();
    session.expiresAt = Date.now() + SESSION_IDLE_TIMEOUT_MS;
    session.actionsExecuted++;
  }

  /**
   * End a session and release all resources.
   */
  async end(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    this.sessions.delete(sessionId);
    logger.info("SessionManager: session ended", {
      sessionId,
      domain: session.domain,
      actionsExecuted: session.actionsExecuted,
    });

    return session;
  }

  /**
   * Get session info (without internal resources).
   */
  getInfo(sessionId) {
    const session = this.get(sessionId);
    return session ? this._toInfo(session) : null;
  }

  _toInfo(session) {
    return {
      sessionId: session.id,
      status: "active",
      domain: session.domain,
      capabilities: session.manifest?.capabilities || [],
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      actionsExecuted: session.actionsExecuted,
    };
  }

  /** Get current stats */
  stats() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
    };
  }

  /**
   * Start background sweeper that closes idle sessions.
   */
  startSweeper(isolatePool, browserPool) {
    if (this._sweeperInterval) {
      return;
    }
    this._sweeperInterval = setInterval(async () => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now > session.expiresAt) {
          logger.info("SessionManager: sweeping expired session", {
            sessionId: id,
            domain: session.domain,
          });
          this.sessions.delete(id);
          try {
            await isolatePool.teardownSession(session.sessionCtx);
          } catch (_) {}
          try {
            await browserPool.release(session.browserSession.context);
          } catch (_) {}
        }
      }
    }, 60_000).unref(); // Check every minute
    logger.info("SessionManager: idle session sweeper started");
  }

  stopSweeper() {
    if (this._sweeperInterval) {
      clearInterval(this._sweeperInterval);
      this._sweeperInterval = null;
    }
  }
}

module.exports = { SessionManager };
