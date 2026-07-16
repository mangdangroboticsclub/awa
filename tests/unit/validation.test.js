"use strict";

/**
 * Validation middleware tests.
 */

describe("validation middleware", () => {
  let validateRequest;
  let ValidationError;

  beforeEach(() => {
    jest.resetModules();
    validateRequest =
      require("../../src/middleware/validation").validateRequest;
    ValidationError = require("../../src/utils/errors").ValidationError;
  });

  function mockReq(body) {
    return { body };
  }

  function mockRes() {
    return {};
  }

  it("should call next() for a valid request with all required fields", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      sku: "6534211",
      targetUrl: "https://www.bestbuy.com/site/product/6534211",
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body.quantity).toBe(1); // default applied
    expect(req.body.options).toEqual({}); // default applied
  });

  it("should call next() with quantity and options provided", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      sku: "6534211",
      targetUrl: "https://www.bestbuy.com/site/product/6534211",
      quantity: 3,
      options: { size: "M", color: "black" },
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body.quantity).toBe(3);
    expect(req.body.options).toEqual({ size: "M", color: "black" });
  });

  it("should call next(ValidationError) when domain is missing", () => {
    const req = mockReq({
      sku: "6534211",
      targetUrl: "https://www.bestbuy.com/site/product/6534211",
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].httpStatus).toBe(400);
    expect(next.mock.calls[0][0].message).toContain("domain");
  });

  it("should call next(ValidationError) when sku is missing", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      targetUrl: "https://www.bestbuy.com/site/product/6534211",
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].message).toContain("sku");
  });

  it("should call next(ValidationError) when targetUrl is missing", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      sku: "6534211",
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].message).toContain("targetUrl");
  });

  it("should call next(ValidationError) when targetUrl is not a valid URI", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      sku: "6534211",
      targetUrl: "not-a-valid-uri",
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].message).toMatch(/targetUrl|format/);
  });

  it("should call next(ValidationError) when quantity is less than 1", () => {
    const req = mockReq({
      domain: "bestbuy.com",
      sku: "6534211",
      targetUrl: "https://www.bestbuy.com/site/product/6534211",
      quantity: 0,
    });
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("should call next(ValidationError) when all required fields are missing", () => {
    const req = mockReq({});
    const res = mockRes();
    const next = jest.fn();

    validateRequest(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    const errMsg = next.mock.calls[0][0].message;
    expect(errMsg).toContain("domain");
    expect(errMsg).toContain("sku");
    expect(errMsg).toContain("targetUrl");
  });
});
