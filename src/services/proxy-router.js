"use strict";

/**
 * Proxy Router — Routes egress traffic through a rotating residential proxy.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  🚨 AMAZON BOT DETECTION WARNING                                      ║
 * ║                                                                        ║
 * ║  Amazon aggressively blocks datacenter IPs and headless browsers.      ║
 * ║  Without a residential proxy (PROXY_MODE=residential), all Amazon     ║
 * ║  skill actions will likely return status="blocked".                    ║
 * ║                                                                        ║
 * ║  Symptoms of detection:                                                ║
 * ║    - skill returns { status: "blocked", detection: ["CAPTCHA"] }       ║
 * ║    - Worker logs "Amazon bot detection — blocking"                     ║
 * ║    - Page redirects to amazon.com homepage instead of search results   ║
 * ║                                                                        ║
 * ║  Solutions (recommended proxy providers):                              ║
 * ║    1. Brightdata (brightdata.com) — best for Amazon                    ║
 * ║    2. Oxylabs (oxylabs.io) — good rotating residential pool            ║
 * ║    3. Smartproxy (smartproxy.com) — budget option                      ║
 * ║    4. IPRoyal (iproyal.com) — rotating residential                     ║
 * ║                                                                        ║
 * ║  See docker-compose.yml for configuration.                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
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
 */

const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  mode: process.env.PROXY_MODE || "none",
  providerUrl: process.env.PROXY_PROVIDER_URL || "",
  apiKey: process.env.PROXY_API_KEY || "",
  // Optional: country filter for residential IPs (e.g., "US", "GB")
  country: process.env.PROXY_COUNTRY || "",
  // Optional: stickiness — reuse same IP for a session duration
  sessionDuration: parseInt(process.env.PROXY_SESSION_DURATION_MS, 10) || 5 * 60 * 1000,
};

/**
 * Get a proxy server URL with optional API key injection.
 *
 * Supports these proxy provider formats:
 *
 *   Brightdata (recommended):
 *     PROXY_PROVIDER_URL=http://brd-customer-<CUSTOMER>-zone-<ZONE>:<PASS>@zproxy.lum-superproxy.io:22225
 *     PROXY_COUNTRY=us
 *     → Generates: http://brd-customer-<CUSTOMER>-zone-<ZONE>-country-us:<PASS>@zproxy.lum-superproxy.io:22225
 *
 *   Oxylabs:
 *     PROXY_PROVIDER_URL=http://customer-<CUSTOMER>:<PASS>@pr.oxylabs.io:7777
 *     → Generates: http://customer-<CUSTOMER>:<PASS>@pr.oxylabs.io:7777
 *
 *   Smartproxy:
 *     PROXY_PROVIDER_URL=http://<USER>:<PASS>@gate.smartproxy.com:10000
 *     → Generates: http://<USER>:<PASS>@gate.smartproxy.com:10000
 *
 *   IPRoyal:
 *     PROXY_PROVIDER_URL=http://<TOKEN>:@residential.iproyal.com:12323
 *     → Generates: http://<TOKEN>:@residential.iproyal.com:12323
 */
function _buildProxyUrl() {
  if (!CONFIG.providerUrl) {
    return "";
  }

  let url = CONFIG.providerUrl;

  // Inject API key if the URL contains a placeholder for it
  if (CONFIG.apiKey && url.indexOf("{API_KEY}") !== -1) {
    url = url.replace("{API_KEY}", CONFIG.apiKey);
  }

  // Inject country filter for Brightdata-style proxy URLs
  if (CONFIG.country && url.indexOf("-country-") === -1) {
    // Brightdata: inject country into the zone
    url = url.replace(
      /(brd-customer-[^@]+-zone-)([^:]+)/,
      "$1$2-country-" + CONFIG.country.toLowerCase()
    );
  }

  return url;
}

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
      // --- Additional anti-fingerprinting ---
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-extensions",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--enable-features=NetworkService,NetworkServiceInProcess",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-field-trial-config",
      "--disable-site-isolation-trials",
      "--disable-component-update",
    ],
  };

  if (CONFIG.mode === "residential" && CONFIG.providerUrl) {
    const proxyUrl = _buildProxyUrl();
    if (proxyUrl) {
      options.args.push(`--proxy-server=${proxyUrl}`);
    }

    logger.info("ProxyRouter: residential proxy configured", {
      mode: CONFIG.mode,
      country: CONFIG.country || "none",
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

  const proxyUrl = _buildProxyUrl();
  if (!proxyUrl) return null;

  return {
    server: proxyUrl,
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
  CONFIG,
};
