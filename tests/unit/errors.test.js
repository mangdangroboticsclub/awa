"use strict";

const {
  AWAError,
  ValidationError,
  ScriptNotFoundError,
  RateLimitedError,
  OverloadedError,
  ExecutionFailedError,
  MemoryOverflowError,
  TimeoutError,
  MerchantBlockedError,
} = require("../../src/utils/errors");

describe("AWAError (base class)", () => {
  it("should create an error with the correct properties", () => {
    const err = new AWAError("test message", "TestCode", 418);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AWAError);
    expect(err.message).toBe("test message");
    expect(err.code).toBe("TestCode");
    expect(err.httpStatus).toBe(418);
    expect(err.name).toBe("AWAError");
  });

  it("should default to httpStatus 500", () => {
    const err = new AWAError("msg", "Code");
    expect(err.httpStatus).toBe(500);
  });

  it("should serialize to JSON correctly", () => {
    const err = new AWAError("something broke", "Oops", 400);
    expect(err.toJSON()).toEqual({
      error: "Oops",
      details: "something broke",
    });
  });
});

describe("ValidationError", () => {
  it("should set code ValidationError and status 400", () => {
    const err = new ValidationError("Field x is required");
    expect(err.code).toBe("ValidationError");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe("Field x is required");
    expect(err).toBeInstanceOf(AWAError);
  });
});

describe("ScriptNotFoundError", () => {
  it("should include the domain in the message", () => {
    const err = new ScriptNotFoundError("bestbuy.com");
    expect(err.code).toBe("ScriptNotFound");
    expect(err.httpStatus).toBe(404);
    expect(err.message).toContain("bestbuy.com");
  });
});

describe("RateLimitedError", () => {
  it("should set code RateLimited and status 429", () => {
    const err = new RateLimitedError();
    expect(err.code).toBe("RateLimited");
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it("should accept custom retry seconds", () => {
    const err = new RateLimitedError(10);
    expect(err.retryAfterSeconds).toBe(10);
    expect(err.message).toContain("10");
  });
});

describe("OverloadedError", () => {
  it("should set code Overloaded and status 503", () => {
    const err = new OverloadedError();
    expect(err.code).toBe("Overloaded");
    expect(err.httpStatus).toBe(503);
  });
});

describe("ExecutionFailedError", () => {
  it("should set code ExecutionFailed and status 200", () => {
    const err = new ExecutionFailedError("Add to cart failed");
    expect(err.code).toBe("ExecutionFailed");
    expect(err.httpStatus).toBe(200);
    expect(err.message).toBe("Add to cart failed");
  });

  it("should use default message when none provided", () => {
    const err = new ExecutionFailedError();
    expect(err.message).toBe("Script execution completed with errors");
  });
});

describe("MemoryOverflowError", () => {
  it("should set code MemoryOverflow and status 200", () => {
    const err = new MemoryOverflowError();
    expect(err.code).toBe("MemoryOverflow");
    expect(err.httpStatus).toBe(200);
    expect(err.message).toContain("memory threshold");
  });
});

describe("TimeoutError", () => {
  it("should set code Timeout and status 200", () => {
    const err = new TimeoutError();
    expect(err.code).toBe("Timeout");
    expect(err.httpStatus).toBe(200);
    expect(err.message).toContain("30s");
  });
});

describe("MerchantBlockedError", () => {
  it("should set code MerchantBlocked and status 200", () => {
    const err = new MerchantBlockedError();
    expect(err.code).toBe("MerchantBlocked");
    expect(err.httpStatus).toBe(200);
    expect(err.message).toContain("blocking");
  });
});
