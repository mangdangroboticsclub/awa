"use strict";

/**
 * Proxy Router unit tests.
 */

describe("proxy-router", () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
  });

  describe("with PROXY_MODE=none", () => {
    it("should return launch options without proxy args", () => {
      process.env.PROXY_MODE = "none";
      const {
        getBrowserLaunchOptions,
        isProxyEnabled,
      } = require("../../src/services/proxy-router");

      const options = getBrowserLaunchOptions();
      expect(options.headless).toBe(true);
      expect(options.args).toEqual(
        expect.arrayContaining(["--no-sandbox", "--disable-setuid-sandbox"]),
      );
      expect(isProxyEnabled()).toBe(false);
    });

    it("should return null context proxy config", () => {
      process.env.PROXY_MODE = "none";
      const {
        getContextProxyConfig,
      } = require("../../src/services/proxy-router");

      expect(getContextProxyConfig()).toBeNull();
    });
  });

  describe("with PROXY_MODE=residential", () => {
    it("should enable proxy when provider URL is set", () => {
      process.env.PROXY_MODE = "residential";
      process.env.PROXY_PROVIDER_URL = "http://proxy.example.com:8080";
      const { isProxyEnabled } = require("../../src/services/proxy-router");

      expect(isProxyEnabled()).toBe(true);
    });

    it("should return context proxy config with server URL", () => {
      process.env.PROXY_MODE = "residential";
      process.env.PROXY_PROVIDER_URL = "http://proxy.example.com:8080";
      const {
        getContextProxyConfig,
      } = require("../../src/services/proxy-router");

      const config = getContextProxyConfig();
      expect(config).toEqual({
        server: "http://proxy.example.com:8080",
      });
    });

    it("should not enable proxy when provider URL is empty", () => {
      process.env.PROXY_MODE = "residential";
      process.env.PROXY_PROVIDER_URL = "";
      const { isProxyEnabled } = require("../../src/services/proxy-router");

      expect(isProxyEnabled()).toBe(false);
    });
  });

  describe("headless mode", () => {
    it("should respect PLAYWRIGHT_HEADLESS env var", () => {
      process.env.PLAYWRIGHT_HEADLESS = "false";
      const {
        getBrowserLaunchOptions,
      } = require("../../src/services/proxy-router");

      const options = getBrowserLaunchOptions();
      expect(options.headless).toBe(false);
    });
  });

  describe("with no env vars set (defaults)", () => {
    it("should default to proxy bypassed", () => {
      // Clear relevant env vars
      delete process.env.PROXY_MODE;
      delete process.env.PROXY_PROVIDER_URL;

      const {
        isProxyEnabled,
        getContextProxyConfig,
      } = require("../../src/services/proxy-router");

      expect(isProxyEnabled()).toBe(false);
      expect(getContextProxyConfig()).toBeNull();
    });
  });
});
