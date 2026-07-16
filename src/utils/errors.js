"use strict";

/**
 * Error classes for the AWA Worker Service.
 *
 * Maps internal error conditions to HTTP status codes and
 * structured error responses matching the API spec (API.md §5).
 */

class AWAError extends Error {
  constructor(message, code, httpStatus = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.code,
      details: this.message,
    };
  }
}

class ValidationError extends AWAError {
  constructor(message) {
    super(message, "ValidationError", 400);
  }
}

class ScriptNotFoundError extends AWAError {
  constructor(domain) {
    super(
      `No skill script registered for domain: ${domain}`,
      "ScriptNotFound",
      404,
    );
  }
}

class RateLimitedError extends AWAError {
  constructor(retryAfterSeconds = 5) {
    super(
      `Too many requests. Retry after ${retryAfterSeconds} seconds.`,
      "RateLimited",
      429,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class OverloadedError extends AWAError {
  constructor() {
    super("All worker slots are busy. Retry later.", "Overloaded", 503);
  }
}

class ExecutionFailedError extends AWAError {
  constructor(details) {
    super(
      details || "Script execution completed with errors",
      "ExecutionFailed",
      200,
    );
  }
}

class MemoryOverflowError extends AWAError {
  constructor() {
    super("Execution memory threshold exceeded.", "MemoryOverflow", 200);
  }
}

class TimeoutError extends AWAError {
  constructor() {
    super("Script exceeded 30s execution time limit.", "Timeout", 200);
  }
}

class MerchantBlockedError extends AWAError {
  constructor() {
    super("Merchant blocking detected.", "MerchantBlocked", 200);
  }
}

module.exports = {
  AWAError,
  ValidationError,
  ScriptNotFoundError,
  RateLimitedError,
  OverloadedError,
  ExecutionFailedError,
  MemoryOverflowError,
  TimeoutError,
  MerchantBlockedError,
};
