"use strict";

/**
 * mpx-awa seed — DEPRECATED
 *
 * The service-side seed command is no longer used.
 * Publishing is handled exclusively through the gateway's POST /v1/publish endpoint.
 */

module.exports = function seed() {
  console.error("");
  console.error("  ╔══════════════════════════════════════════════════════════╗");
  console.error("  ║  DEPRECATED                                             ║");
  console.error("  ║                                                        ║");
  console.error("  ║  `mpx-awa seed` has been removed.                       ║");
  console.error("  ║                                                        ║");
  console.error("  ║  Publishing is now handled through the gateway's         ║");
  console.error("  ║  POST /v1/publish endpoint. Use `mpx-awa publish`        ║");
  console.error("  ║  on the host, which calls the gateway automatically.     ║");
  console.error("  ╚══════════════════════════════════════════════════════════╝");
  console.error("");
  process.exit(1);
};
