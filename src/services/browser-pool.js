"use strict";

/**
 * Browser Pool — Manages Playwright browser contexts for secure, isolated
 * browser sessions.
 *
 * Architecture (see ARCHITECTURE.md §4):
 *   - Single Chromium process launched via playwright-extra + StealthPlugin
 *   - Isolated BrowserContext objects per tenant (up to BROWSER_POOL_SIZE)
 *   - Each context gets a fresh Page
 *   - State elimination on release (cookies cleared, context closed)
 *   - Proxy integration via proxy-router
 *
 * Concurrency model (see ARCHITECTURE.md §4.1):
 *   Cloud Run Instance
 *   ├── Chromium Process (single)
 *   │   ├── BrowserContext #1 (Session A)
 *   │   │   └── Page #1
 *   │   ├── BrowserContext #2 (Session B)
 *   │   │   └── Page #2
 *   │   └── ... (up to BROWSER_POOL_SIZE)
 *   └── ...
 */

const { chromium } = require("playwright-extra");
const stealthPlugin = require("puppeteer-extra-plugin-stealth");
const logger = require("../utils/logger");
const { getBrowserLaunchOptions, getContextProxyConfig } = require("./proxy-router");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  poolSize: parseInt(process.env.BROWSER_POOL_SIZE, 10) || 40,
  chromePath: process.env.CHROME_PATH || "",
};

/**
 * Check if Playwright's bundled Chromium is available.
 */
function hasBundledChromium() {
  const path = require("path");
  const home = process.env.HOME || "/home/node";
  const bundledPath = path.join(home, ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome");
  const { existsSync } = require("fs");
  return existsSync(bundledPath);
}

// ---------------------------------------------------------------------------
// Browser Pool
// ---------------------------------------------------------------------------

class BrowserPool {
  constructor(options = {}) {
    this.poolSize = options.poolSize ?? CONFIG.poolSize;

    /** @type {import('playwright').Browser|null} */
    this.browser = null;

    /** @type {Set<import('playwright').BrowserContext>} */
    this.activeContexts = new Set();

    this._initialized = false;
    this._initializing = null;
    this._chromiumStatus = "stopped";

    logger.info("BrowserPool created", {
      poolSize: this.poolSize,
      chromePath: CONFIG.chromePath,
    });
  }

  /**
   * Initialize Playwright and launch the Chromium browser.
   * Uses playwright-extra with StealthPlugin for anti-detection.
   */
  async initialize() {
    if (this._initializing) {
      return this._initializing;
    }
    if (this._initialized) {
      return;
    }

    this._initializing = this._doInitialize();
    return this._initializing;
  }

  async _doInitialize() {
    logger.info("BrowserPool: launching Chromium");
    this._chromiumStatus = "starting";

    try {
      // Register the stealth plugin
      chromium.use(stealthPlugin());

      // Get launch options
      const launchOptions = getBrowserLaunchOptions();

      // Use bundled Playwright Chromium if available (preferred)
      // Fall back to CHROME_PATH only if explicitly configured
      if (hasBundledChromium()) {
        // Playwright uses its bundled browser by default — no need to set path
        logger.debug("BrowserPool: using bundled Chromium");
      } else if (CONFIG.chromePath) {
        launchOptions.executablePath = CONFIG.chromePath;
        logger.debug("BrowserPool: using configured Chromium path", {
          path: CONFIG.chromePath,
        });
      }

      logger.debug("BrowserPool: launch options", {
        headless: launchOptions.headless,
        executablePath: launchOptions.executablePath || "(bundled)",
      });

      // Launch the browser
      this.browser = await chromium.launch(launchOptions);

      this._chromiumStatus = "running";
      this._initialized = true;
      logger.info("BrowserPool: Chromium launched successfully");
    } catch (err) {
      this._chromiumStatus = "crashed";
      logger.error("BrowserPool: failed to launch Chromium", {
        error: err.message,
        chromePath: CONFIG.chromePath,
      });
      throw err;
    } finally {
      this._initializing = null;
    }
  }

  /**
   * Acquire a browser context and page for a new session.
   *
   * @param {string} [domain] - Optional domain for proxy routing
   * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
   */
  async acquire(domain) {
    await this.ensureInitialized();

    if (this.activeContexts.size >= this.poolSize) {
      throw Object.assign(new Error("All browser slots are busy. Retry later."), {
        code: "BROWSER_POOL_FULL",
      });
    }

    // Create a new isolated browser context with realistic fingerprint
    const contextOptions = {
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.006 },
      permissions: ["geolocation"],
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    };
    const proxyConfig = getContextProxyConfig();
    if (proxyConfig) {
      contextOptions.proxy = proxyConfig;
    }

    const context = await this.browser.newContext(contextOptions);

    // Create a fresh page
    const page = await context.newPage();

    // Apply page-level stealth overrides to evade bot detection
    await page.addInitScript(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, "webdriver", { get: () => false });

      // Override navigator.plugins to appear as a normal browser
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override navigator.languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // Override chrome.runtime (present in real Chrome, absent in headless)
      if (!window.chrome) {
        window.chrome = {};
      }
      window.chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {} },
        onConnect: { addListener: () => {} },
      };

      // Override permissions query to avoid detection
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });

    this.activeContexts.add(context);

    logger.debug("BrowserPool: context acquired", {
      domain: domain || "unknown",
      activeCount: this.activeContexts.size,
    });

    return { context, page };
  }

  /**
   * Release a browser context — clears state and closes it.
   * Implements state elimination as required by SECURITY.md §5.1.
   *
   * @param {import('playwright').BrowserContext} context
   */
  async release(context) {
    if (!this.activeContexts.has(context)) {
      logger.warn("BrowserPool: attempt to release unknown context");
      return;
    }

    try {
      // State elimination (see SECURITY.md §5.1)
      await context.clearCookies();
      await context.clearPermissions();
      await context.close();
    } catch (err) {
      logger.warn("BrowserPool: error during context cleanup", {
        error: err.message,
      });
    }

    this.activeContexts.delete(context);

    logger.debug("BrowserPool: context released", {
      activeCount: this.activeContexts.size,
    });
  }

  /**
   * Ensure the browser is initialized. Call before any operation.
   */
  async ensureInitialized() {
    if (!this._initialized) {
      await this.initialize();
    }
  }

  /**
   * Get current pool statistics.
   */
  stats() {
    return {
      chromiumStatus: this._chromiumStatus,
      activeSessions: this.activeContexts.size,
      poolSize: this.poolSize,
      initialized: this._initialized,
    };
  }

  /**
   * Stop the browser pool — close the browser and all active contexts.
   */
  async stop() {
    logger.info("BrowserPool: stopping");

    // Close all active contexts
    for (const context of this.activeContexts) {
      try {
        await context.close();
      } catch (err) {
        logger.warn("BrowserPool: error closing context", {
          error: err.message,
        });
      }
    }
    this.activeContexts.clear();

    // Close the browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        logger.warn("BrowserPool: error closing browser", {
          error: err.message,
        });
      }
      this.browser = null;
    }

    this._chromiumStatus = "stopped";
    this._initialized = false;
    logger.info("BrowserPool: stopped");
  }
}

module.exports = { BrowserPool };
