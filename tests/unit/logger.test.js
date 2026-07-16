"use strict";

/**
 * Logger tests — capture stdout/stderr and verify structured JSON output.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function captureStream(stream) {
  const origWrite = stream.write.bind(stream);
  const chunks = [];
  stream.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  return {
    chunks,
    restore: () => {
      stream.write = origWrite;
    },
    lines: () => chunks.map((c) => c.toString().trim()).filter(Boolean),
  };
}

describe("logger", () => {
  let logger;
  let stdoutCapture;
  let stderrCapture;

  beforeEach(() => {
    // Reset LOG_LEVEL to debug for tests
    process.env.LOG_LEVEL = "debug";

    // Clear module cache to get a fresh logger
    jest.resetModules();

    stdoutCapture = captureStream(process.stdout);
    stderrCapture = captureStream(process.stderr);

    logger = require("../../src/utils/logger");
  });

  afterEach(() => {
    stdoutCapture.restore();
    stderrCapture.restore();
    delete process.env.LOG_LEVEL;
  });

  function parseJsonLines(capture) {
    return capture.lines().map((l) => JSON.parse(l));
  }

  it("should export error, warn, info, debug methods", () => {
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("should output error messages to stderr", () => {
    logger.error("something failed", { sessionId: "abc" });
    const lines = parseJsonLines(stderrCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].level).toBe("error");
    expect(lines[0].msg).toBe("something failed");
    expect(lines[0].sessionId).toBe("abc");
    expect(lines[0].timestamp).toBeDefined();
  });

  it("should output warn messages to stderr", () => {
    logger.warn("rate limit approaching");
    const lines = parseJsonLines(stderrCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].level).toBe("warn");
  });

  it("should output info messages to stdout", () => {
    logger.info("server started", { port: 8080 });
    const lines = parseJsonLines(stdoutCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].port).toBe(8080);
  });

  it("should output debug messages to stdout", () => {
    logger.debug("verbose detail");
    const lines = parseJsonLines(stdoutCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].level).toBe("debug");
  });

  it("should suppress debug logs when LOG_LEVEL=info", () => {
    process.env.LOG_LEVEL = "info";
    jest.resetModules();
    logger = require("../../src/utils/logger");

    logger.debug("should not appear");
    logger.info("should appear");

    const lines = parseJsonLines(stdoutCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].msg).toBe("should appear");
  });

  it("should suppress warn logs when LOG_LEVEL=error", () => {
    process.env.LOG_LEVEL = "error";
    jest.resetModules();
    logger = require("../../src/utils/logger");

    logger.warn("should not appear");
    logger.error("should appear");

    const stderrLines = parseJsonLines(stderrCapture);
    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0].level).toBe("error");
  });

  it("should support child loggers with default meta", () => {
    const child = logger.child({ sessionId: "sess-1", domain: "example.com" });
    child.info("child message", { extra: "data" });

    const lines = parseJsonLines(stdoutCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].sessionId).toBe("sess-1");
    expect(lines[0].domain).toBe("example.com");
    expect(lines[0].extra).toBe("data");
    expect(lines[0].msg).toBe("child message");
  });

  it("child logger should merge meta (child meta overridden by call meta)", () => {
    const child = logger.child({ sessionId: "sess-1", role: "worker" });
    child.info("override test", { sessionId: "sess-2" });

    const lines = parseJsonLines(stdoutCapture);
    expect(lines.length).toBe(1);
    expect(lines[0].sessionId).toBe("sess-2");
    expect(lines[0].role).toBe("worker");
  });
});
