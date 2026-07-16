"use strict";

const ivm = require("isolated-vm");
const logger = require("../utils/logger");
const { screenOrThrow } = require("./script-screener");

const CONFIG = {
  memoryLimitMB: parseInt(process.env.ISOLATE_MEMORY_LIMIT_MB, 10) || 128,
  timeoutMs: parseInt(process.env.ISOLATE_TIMEOUT_MS, 10) || 30_000,
  poolSize: parseInt(process.env.ISOLATE_POOL_SIZE, 10) || 20,
};

// ---------------------------------------------------------------------------
// $awa.* API surface builder
// ---------------------------------------------------------------------------

/**
 * Wrapper that ensures all errors are caught and returned as structured
 * result objects instead of throwing through the ivm Reference bridge.
 * This prevents non-cloneable Playwright internals from crashing the isolate.
 */
function wrapHostFn(fn) {
  return async (...args) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function buildSandboxApi(page) {
  return {
    navigate: wrapHostFn(async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }),
    click: wrapHostFn(async (selector) => {
      await page.click(selector);
    }),
    type: wrapHostFn(async (selector, text) => {
      await page.fill(selector, text);
    }),
    select: wrapHostFn(async (selector, value) => {
      await page.selectOption(selector, value);
    }),
    extractText: wrapHostFn(async (selector) => page.textContent(selector)),
    extractAttribute: wrapHostFn(async (selector, attr) => page.getAttribute(selector, attr)),
    extractHtml: wrapHostFn(async (selector) => page.innerHTML(selector)),
    waitForSelector: wrapHostFn(async (selector, timeout) => {
      await page.waitForSelector(selector, { timeout: timeout || 5000 });
    }),
    waitForNavigation: wrapHostFn(async () => {
      await page.waitForNavigation();
    }),
    sleep: wrapHostFn(async (ms) => new Promise((r) => setTimeout(r, ms))),
    currentUrl: wrapHostFn(async () => page.url()),
    evaluate: wrapHostFn(async (fn) => page.evaluate(fn)),
    screenshot: wrapHostFn(async () =>
      (await page.screenshot({ encoding: "base64" })).toString("base64"),
    ),
  };
}

// ---------------------------------------------------------------------------
// Generate the $awa.* injection code for the isolate
// ---------------------------------------------------------------------------

function generateAwaDefs(apiNames) {
  return apiNames
    .map(
      (name) =>
        `$awa.${name} = async (...args) => { const __r = await __awa_api_${name}.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } }); if (!__r.ok) throw new Error(__r.error); return __r.value; };`,
    )
    .join("\n");
}

/**
 * Build the script that defines $awa.* and the handler dispatch mechanism.
 * The isolate has no CommonJS module system, so we provide a `module` shim
 * so that user scripts can use `module.exports = { handlers: {...} }`.
 */
function buildSessionScript(apiNames, scriptSource) {
  const awaDefs = generateAwaDefs(apiNames);
  return `
const $awa = {};
${awaDefs}

// Provide a CommonJS module shim for the isolate
const module = { exports: {} };

// User's skill definition
${scriptSource}

// Capture exported manifest and handlers
const __skill = module.exports;
const handlers = __skill.handlers || {};
const manifest = __skill.manifest || {};
`;
}

// ---------------------------------------------------------------------------
// Isolate Pool — extended for session-based execution
// ---------------------------------------------------------------------------

class IsolatePool {
  constructor(options = {}) {
    this.poolSize = options.poolSize ?? CONFIG.poolSize;
    this.memoryLimitMB = options.memoryLimitMB ?? CONFIG.memoryLimitMB;
    this.timeoutMs = options.timeoutMs ?? CONFIG.timeoutMs;

    this.available = [];
    this.inUse = new Set();
    this.stopped = false;
    this._warmPromise = null;

    logger.info("IsolatePool created", {
      poolSize: this.poolSize,
      memoryLimitMB: this.memoryLimitMB,
      timeoutMs: this.timeoutMs,
    });
  }

  warm() {
    if (!this._warmPromise) this._warmPromise = this._doWarm();
  }

  async _doWarm() {
    const count = Math.min(5, this.poolSize);
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => this._createIsolate()),
    );
    for (const r of results) {
      if (r.status === "fulfilled") this.available.push(r.value);
    }
    logger.debug("IsolatePool: warming complete", { warmed: this.available.length });
  }

  async acquire() {
    if (this.stopped) throw new Error("IsolatePool has been stopped");
    let iso = this.available.pop();
    if (!iso) {
      iso = await this._createIsolate();
    }
    this.inUse.add(iso);
    return iso;
  }

  release(isolate) {
    if (!this.inUse.has(isolate)) return;
    this.inUse.delete(isolate);
    if (this.available.length < this.poolSize && !this.stopped) {
      this.available.push(isolate);
    } else {
      this._destroyIsolate(isolate);
    }
  }

  // -----------------------------------------------------------------------
  // Session-based execution
  // -----------------------------------------------------------------------

  /**
   * Set up a V8 isolate for a session: compile the skill + inject $awa.*
   *
   * @returns {object} sessionContext — { isolate, context, global, apiRefs }
   */
  async setupSession({ scriptSource, page, manifest, timeoutMs }) {
    const timeout = timeoutMs || this.timeoutMs;
    const api = buildSandboxApi(page);
    const apiNames = Object.keys(api);

    // Create ivm references for host API functions
    const apiRefs = {};
    for (const name of apiNames) {
      apiRefs[name] = new ivm.Reference(api[name]);
    }

    const isolate = await this.acquire();
    const context = await isolate.createContext();
    const global = context.global;

    // Inject $awa.* API references into isolate global scope
    for (const name of apiNames) {
      await global.set(`__awa_api_${name}`, apiRefs[name]);
    }

    // Compile and run the session setup script (no return value expected)
    const setupScript = buildSessionScript(apiNames, scriptSource);
    await context.eval(setupScript, { timeout });

    // Validate that handlers are present
    const hasHandlers = await context.eval(
      "typeof handlers !== 'undefined' && Object.keys(handlers).length > 0",
      { timeout, copy: true },
    );
    if (!hasHandlers) {
      throw new Error("Skill script must export handlers object via module.exports");
    }

    const sessionCtx = { isolate, context, global, apiRefs, apiNames, timeout, manifest };
    return sessionCtx;
  }

  /**
   * Invoke a single handler inside an active session's isolate.
   */
  async invokeHandler(sessionCtx, actionName, params = {}) {
    const { context, timeout, manifest } = sessionCtx;
    const effectiveTimeout = (manifest && manifest.timeout) || timeout;

    // Check handler exists
    const handlerExists = await context.eval(`typeof handlers["${actionName}"] === 'function'`, {
      timeout: effectiveTimeout,
      copy: true,
    });
    if (!handlerExists) {
      return {
        status: "failed",
        data: null,
        errorDetails: `Action '${actionName}' not found in skill handlers`,
      };
    }

    // Build params injection
    const paramsCode = Object.entries(params)
      .map(([k, v]) => {
        const safe = JSON.stringify(v);
        return `__awa_params["${k}"] = ${safe};`;
      })
      .join("\n");

    // -- Approach: use a two-step eval without copy:true on the result --
    // Step 1: Create holder + run the handler in a single eval
    // Step 2: Read the holder via synchronously grabbing and converting to JSON

    try {
      // Step 1: Inject params, run handler, capture result in a plain global var
      // The async IIFE always resolves (inner try/catch). The holder is set to a JSON string.
      // We await with promise:true but NO copy:true to avoid any bridge clone errors.
      await context.eval(
        `
        var __awa_result_holder = null;
        var __awa_params = {};
        ${paramsCode}
        (async () => {
          try {
            const __awa_result = await handlers["${actionName}"]({ ...__awa_params, page: {} });
            __awa_result_holder = JSON.stringify({ ok: true, data: __awa_result });
          } catch (__awa_err) {
            const errMsg = typeof __awa_err === 'object' && __awa_err !== null
              ? (__awa_err.message || __awa_err.toString())
              : String(__awa_err);
            __awa_result_holder = JSON.stringify({ ok: false, error: errMsg });
          }
        })()
        `,
        { timeout: effectiveTimeout, promise: true },
      );

      // Step 2: Read the holder via synchronous eval with copy (it's a plain string)
      const raw = await context.eval("__awa_result_holder", { timeout: 5000, copy: true });

      if (!raw) {
        return { status: "failed", data: null, errorDetails: "Action produced no result" };
      }
      const parsed = JSON.parse(raw);
      if (parsed.ok) {
        return { status: "success", data: parsed.data, errorDetails: null };
      }
      return { status: "failed", data: null, errorDetails: parsed.error };
    } catch (err) {
      return { status: "failed", data: null, errorDetails: err.message || String(err) };
    }
  }

  /**
   * Tear down a session's isolate.
   */
  async teardownSession(sessionCtx) {
    for (const ref of Object.values(sessionCtx.apiRefs)) {
      try {
        ref.dispose();
      } catch (_) {}
    }
    this.release(sessionCtx.isolate);
  }

  // -----------------------------------------------------------------------
  // Legacy single-shot execute (kept for backward compatibility)
  // -----------------------------------------------------------------------

  async execute({ domain, scriptSource, page, params }) {
    const log = logger.child({ domain, sku: params.sku });
    try {
      screenOrThrow(scriptSource);
    } catch (err) {
      return { status: "failed", checkoutUrl: null, errorDetails: err.message };
    }

    try {
      const sesCtx = await this.setupSession({ scriptSource, page, timeoutMs: this.timeoutMs });
      const actionName = "execute"; // Fallback: single-shot uses "execute" handler
      const result = await this.invokeHandler(sesCtx, actionName, params);
      await this.teardownSession(sesCtx);
      return {
        status: result.status,
        checkoutUrl: result.data?.checkoutUrl || null,
        errorDetails: result.errorDetails,
      };
    } catch (err) {
      return handleIsolateError(err, log);
    }
  }

  stats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      poolSize: this.poolSize,
      memoryLimitMB: this.memoryLimitMB,
      timeoutMs: this.timeoutMs,
    };
  }

  async stop() {
    this.stopped = true;
    for (const iso of this.available) this._destroyIsolate(iso);
    this.available = [];
    for (const iso of this.inUse) this._destroyIsolate(iso);
    this.inUse.clear();
    logger.info("IsolatePool: stopped");
  }

  async _createIsolate() {
    return new ivm.Isolate({ memoryLimit: this.memoryLimitMB, inspector: false });
  }

  _destroyIsolate(isolate) {
    try {
      isolate.dispose();
    } catch (err) {
      logger.warn("IsolatePool: error destroying isolate", { error: err.message });
    }
  }
}

function handleIsolateError(err, log) {
  const msg = err.message || String(err);
  if (msg.includes("memory") || err instanceof RangeError) {
    log.warn("IsolatePool: memory overflow");
    return {
      status: "failed",
      checkoutUrl: null,
      errorDetails: "Execution memory threshold exceeded.",
    };
  }
  if (msg.includes("timeout") || msg.includes("Script execution timed out")) {
    log.warn("IsolatePool: execution timeout");
    return {
      status: "failed",
      checkoutUrl: null,
      errorDetails: "Script exceeded 30s execution time limit.",
    };
  }
  log.error("IsolatePool: execution error", { error: msg });
  return { status: "failed", checkoutUrl: null, errorDetails: `Script execution error: ${msg}` };
}

module.exports = { IsolatePool };
