"use strict";

const { AWAError } = require("../utils/errors");

class ScriptRejectedError extends AWAError {
  constructor(reason) {
    super(`Script rejected: ${reason}`, "ScriptRejected", 422);
  }
}

// ---------------------------------------------------------------------------
// Forbidden patterns
// ---------------------------------------------------------------------------

const FORBIDDEN_IDENTIFIERS = new Set(["process", "require", "global", "globalThis"]);

const FORBIDDEN_STRINGS = [
  "import(",
  "eval(",
  "Function(",
  "Proxy",
  "Reflect.construct",
  "__proto__",
  "constructor.constructor",
];

const EXECUTE_PATTERNS = [
  /\bexport\s+async\s+function\s+execute\b/,
  /async\s+function\s+execute\s*\(/,
  /handlers\s*:\s*\{/,
  /\bexecute\s*[=:\(]/,
];

function screen(source, options = {}) {
  const maxSizeBytes = options.maxSizeBytes || 10 * 1024 * 1024;

  if (source.length > maxSizeBytes) {
    return {
      passed: false,
      reason: `Script exceeds maximum size of ${(maxSizeBytes / 1024 / 1024).toFixed(0)}MB`,
    };
  }

  for (const ident of FORBIDDEN_IDENTIFIERS) {
    const regex = new RegExp(`\\b${ident}\\b`);
    if (regex.test(source)) {
      return { passed: false, reason: `Forbidden identifier: ${ident}` };
    }
  }

  for (const str of FORBIDDEN_STRINGS) {
    if (source.includes(str)) {
      return { passed: false, reason: `Forbidden pattern: ${str}` };
    }
  }

  const hasHandler = EXECUTE_PATTERNS.some((re) => re.test(source));
  if (!hasHandler) {
    return {
      passed: false,
      reason: 'Script must define handlers or an async function named "execute"',
    };
  }

  return { passed: true };
}

function screenOrThrow(source, options) {
  const result = screen(source, options);
  if (!result.passed) throw new ScriptRejectedError(result.reason);
  return result;
}

module.exports = { screen, screenOrThrow, ScriptRejectedError };
