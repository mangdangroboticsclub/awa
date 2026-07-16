"use strict";

/**
 * Service account authentication middleware.
 *
 * In production, this validates OIDC tokens issued by GCP IAM
 * for service-to-service authentication between OpenClaw Brain
 * and the Cloud Run Core Worker.
 *
 * In local development (NODE_ENV=development), auth is disabled
 * to simplify testing. The middleware passes through all requests.
 */

const logger = require("../utils/logger");

/**
 * Stub token validator for local development.
 * In production, this would verify a Google-issued OIDC identity token
 * against the expected service account audience.
 */
async function validateToken(/* token */) {
  // TODO: Implement OIDC token validation for production
  // 1. Verify the token is a valid JWT signed by Google
  // 2. Check the `aud` claim matches the worker's URL
  // 3. Check the `iss` claim matches `https://accounts.google.com`
  // 4. Verify the `sub` claim matches the expected caller service account
  return {
    valid: true,
    serviceAccount: "brain@openclaw-prod.iam.gserviceaccount.com",
  };
}

/**
 * Authentication middleware.
 * - In development mode: logs a debug message and passes through.
 * - In production: validates the Authorization header (Bearer token).
 */
async function authMiddleware(req, res, next) {
  // Skip auth in local development
  if (process.env.NODE_ENV === "development") {
    logger.debug("Auth middleware: skipped (NODE_ENV=development)");
    req.auth = {
      serviceAccount: "local-dev",
      authenticated: false,
    };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      details:
        "Missing or invalid Authorization header. Expected: Bearer <token>",
    });
  }

  const token = authHeader.slice(7);
  try {
    const result = await validateToken(token);
    if (!result.valid) {
      return res.status(401).json({
        error: "Unauthorized",
        details: "Invalid or expired authentication token.",
      });
    }
    req.auth = result;
    logger.debug("Auth middleware: authenticated", {
      serviceAccount: result.serviceAccount,
    });
    next();
  } catch (err) {
    logger.error("Auth middleware: token validation failed", {
      error: err.message,
    });
    return res.status(401).json({
      error: "Unauthorized",
      details: "Authentication token validation failed.",
    });
  }
}

module.exports = { authMiddleware };
