"use strict";

/**
 * Proxy Router — Routes egress traffic through a rotating residential proxy.
 *
 * In production, all Playwright browser traffic egresses through a rotating
 * residential proxy provider to:
 *   - Bypass geo-restrictions
 *   - Avoid IP-based rate limiting
 *   - Defeat bot detection heuristics
 *   - Provide merchant-specific IP whitelisting capability
 *
 * In local development (PROXY_MODE=none), the proxy is bypassed —
 * traffic goes directly to merchant sites.
 *
 * See ARCHITECTURE.md §6 (Network Architecture) and LOCAL_AWA_SETUP.md §6.1.
 */

const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  mode: process.env.PROXY_MODE || "none",
  providerUrl: process.env.PROXY_PROVIDER_URL || "",
  apiKey: process.env.PROXY_API_KEY || "",
};

/**
 * Build Playwright launch options based on the proxy configuration.
 *
 * @returns {object} Playwright browser launch options with proxy settings
 */
function getBrowserLaunchOptions() {
  const options = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // --- Stealth / anti-detection flags ---
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-features=ChromeWhatsNewUI",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-notifications",
      "--disable-popup-blocking",
      "--ignore-certificate-errors",
      "--disable-sync",
      "--lang=en-US",
    ],
  };

  if (CONFIG.mode === "residential" && CONFIG.providerUrl) {
    // Residential proxy configuration
    // Format: http://user:pass@provider-host:port
    const proxyUrl = CONFIG.providerUrl;
    if (CONFIG.apiKey) {
      // Inject API key into proxy URL if needed
      // (exact format depends on the proxy provider)
      options.args.push(`--proxy-server=${proxyUrl}`);
    }

    logger.info("ProxyRouter: residential proxy configured", {
      providerUrl: proxyUrl.replace(/\/\/.*@/, "//***@"), // redact credentials
    });
  } else {
    logger.info("ProxyRouter: proxy bypassed (PROXY_MODE=none)", {
      mode: CONFIG.mode,
    });
  }

  return options;
}

/**
 * Get the proxy configuration string for use in Playwright context options.
 *
 * @returns {object|null} Proxy config object for Playwright, or null if bypassed
 */
function getContextProxyConfig() {
  if (CONFIG.mode !== "residential" || !CONFIG.providerUrl) {
    return null;
  }

  return {
    server: CONFIG.providerUrl,
    // If the proxy URL contains credentials, Playwright parses them automatically
  };
}

/**
 * Check if the proxy is enabled.
 */
function isProxyEnabled() {
  return CONFIG.mode === "residential" && !!CONFIG.providerUrl;
}

module.exports = {
  getBrowserLaunchOptions,
  getContextProxyConfig,
  isProxyEnabled,
};
