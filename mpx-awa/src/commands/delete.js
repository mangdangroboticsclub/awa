"use strict";

/**
 * mpx-awa delete — DEPRECATED
 *
 * Skill artifacts are managed through the gateway (POST /v1/publish handles
 * versioned uploads). Direct manual deletion of GCS objects is no longer
 * part of the standard workflow.
 */

module.exports = function deleteSkill() {
  console.error("");
  console.error("  ╔══════════════════════════════════════════════════════════╗");
  console.error("  ║  DEPRECATED                                             ║");
  console.error("  ║                                                        ║");
  console.error("  ║  `mpx-awa delete` has been removed.                     ║");
  console.error("  ║                                                        ║");
  console.error("  ║  Skill artifacts are managed through the gateway.        ║");
  console.error("  ║  Use `mpx-awa publish` to upload new versions.          ║");
  console.error("  ║  Direct GCS manipulation is no longer needed.           ║");
  console.error("  ╚══════════════════════════════════════════════════════════╝");
  console.error("");
  process.exit(1);
};
