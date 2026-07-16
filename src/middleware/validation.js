"use strict";

/**
 * Request schema validation middleware.
 *
 * Uses AJV (JSON Schema draft-07) to validate incoming
 * POST /v1/awa/execute requests against the AWARequest schema
 * defined in SDD §3.1 and API.md §2.1.
 */

const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { ValidationError } = require("../utils/errors");

const ajv = new Ajv({ allErrors: true, coerceTypes: true });
addFormats(ajv);

const awaRequestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AWARequest",
  type: "object",
  properties: {
    domain: {
      type: "string",
      description: "Merchant domain used for script lookup",
      examples: ["bestbuy.com"],
    },
    sku: {
      type: "string",
      description: "Stock-keeping unit identifier",
      examples: ["6534211"],
    },
    targetUrl: {
      type: "string",
      format: "uri",
      description: "Product page URL",
    },
    quantity: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "Number of units to purchase",
    },
    options: {
      type: "object",
      additionalProperties: { type: "string" },
      default: {},
      description: "Product variant selections",
      examples: [{ size: "M", color: "black" }],
    },
  },
  required: ["domain", "sku", "targetUrl"],
};

const validateAwaRequest = ajv.compile(awaRequestSchema);

/**
 * Validates the request body against the AWARequest schema.
 * On failure, returns a 400 ValidationError with detailed messages.
 */
function validateRequest(req, res, next) {
  const valid = validateAwaRequest(req.body);
  if (!valid) {
    const details = validateAwaRequest.errors
      .map((e) => `${e.instancePath} ${e.message}`)
      .join("; ");
    return next(new ValidationError(`Field validation failed: ${details}`));
  }

  // Apply defaults
  if (req.body.quantity === undefined) {req.body.quantity = 1;}
  if (req.body.options === undefined) {req.body.options = {};}

  next();
}

module.exports = {
  validateRequest,
  awaRequestSchema,
};
