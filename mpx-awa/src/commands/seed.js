"use strict";

/**
 * mpx-awa seed — DEPRECATED
 *
 * Use `mpx-awa publish <domain>` instead.
 * The publish command uploads to GCS via the gateway, which manages
 * versioning, DB records, and GCS paths automatically.
 */

module.exports = function seed() {
  console.error("");
  console.error("  ╔══════════════════════════════════════════════════════════╗");
  console.error("  ║  DEPRECATED                                             ║");
  console.error("  ║                                                        ║");
  console.error("  ║  `mpx-awa seed` has been removed.                       ║");
  console.error("  ║                                                        ║");
  console.error("  ║  Use `mpx-awa publish <domain>` instead to upload       ║");
  console.error("  ║  your skill through the gateway. This handles version   ║");
  console.error("  ║  management, DB records, and GCS paths automatically.   ║");
  console.error("  ╚══════════════════════════════════════════════════════════╝");
  console.error("");
  console.error("  Example:");
  console.error("    mpx-awa login haris_dev ****");
  console.error("    mpx-awa publish haris_dev~amazon");
  console.error("");
  process.exit(1);
};
