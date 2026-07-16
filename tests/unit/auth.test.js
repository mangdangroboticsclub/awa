"use strict";

/**
 * Auth middleware tests.
 */

describe("auth middleware", () => {
  let authMiddleware;

  beforeEach(() => {
    jest.resetModules();
    // Suppress logger output during tests
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    authMiddleware = require("../../src/middleware/auth").authMiddleware;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockReq(headers, env) {
    const req = {
      headers: headers || {},
      auth: undefined,
    };
    if (env) {
      process.env.NODE_ENV = env;
    }
    return req;
  }

  function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  describe("in development mode", () => {
    const ORIG_NODE_ENV = process.env.NODE_ENV;

    afterAll(() => {
      process.env.NODE_ENV = ORIG_NODE_ENV;
    });

    it("should set req.auth and call next() without validating token", async () => {
      process.env.NODE_ENV = "development";
      const req = mockReq({}, "development");
      const res = mockRes();
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.auth).toEqual({
        serviceAccount: "local-dev",
        authenticated: false,
      });
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("in production mode", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "production";
    });

    afterAll(() => {
      process.env.NODE_ENV = "development";
    });

    it("should return 401 when Authorization header is missing", async () => {
      const req = mockReq({});
      const res = mockRes();
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        details: expect.stringContaining("Missing"),
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when Authorization header is not Bearer", async () => {
      const req = mockReq({ authorization: "Basic abc123" });
      const res = mockRes();
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        details: expect.stringContaining("Missing"),
      });
    });

    it("should call next() when a valid Bearer token is provided", async () => {
      const req = mockReq({ authorization: "Bearer valid-token-123" });
      const res = mockRes();
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.auth).toBeDefined();
      expect(req.auth.valid).toBe(true);
      expect(req.auth.serviceAccount).toBe(
        "brain@openclaw-prod.iam.gserviceaccount.com",
      );
    });
  });
});
