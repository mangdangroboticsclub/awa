"use strict";

/**
 * Structured JSON logger for the AWA Worker Service.
 *
 * Log levels: error, warn, info, debug
 * Outputs newline-delimited JSON (ndjson) to stdout.
 * In production (NODE_ENV=production), debug logs are suppressed.
 */

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function baseLog(level, msg, meta = {}) {
  if (LEVELS[level] === undefined) {return;}
  if (LEVELS[level] > CURRENT_LEVEL) {return;}

  const entry = {
    level,
    msg,
    timestamp: formatTimestamp(),
    ...meta,
  };

  if (level === "error" || level === "warn") {
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

const logger = {
  error(msg, meta) {
    baseLog("error", msg, meta);
  },
  warn(msg, meta) {
    baseLog("warn", msg, meta);
  },
  info(msg, meta) {
    baseLog("info", msg, meta);
  },
  debug(msg, meta) {
    baseLog("debug", msg, meta);
  },
  child(defaultMeta) {
    const childLogger = {};
    for (const method of ["error", "warn", "info", "debug"]) {
      childLogger[method] = (msg, meta) => {
        baseLog(method, msg, { ...defaultMeta, ...meta });
      };
    }
    return childLogger;
  },
};

module.exports = logger;
