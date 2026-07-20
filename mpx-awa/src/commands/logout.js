"use strict";

/**
 * mpx-awa logout — Clear the stored JWT token.
 *
 * Usage:
 *   mpx-awa logout
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN_FILE = path.join(os.homedir(), ".mpx-awa-token");

module.exports = function logout() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      console.log("  ✅ Logged out. Token removed.");
    } else {
      console.log("  ℹ️  No token found — you're already logged out.");
    }
  } catch (err) {
    console.error(`  ✗ Failed to remove token: ${err.message}`);
    process.exit(1);
  }
};
