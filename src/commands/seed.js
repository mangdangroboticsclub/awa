"use strict";

/**
 * mpx-awa seed — Seed a skill to the GCS emulator.
 *
 * Usage: mpx-awa seed <domain>
 * Usage: mpx-awa seed <domain> --worker <url>
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const GCS_EMULATOR = process.env.GCS_EMULATOR_URL || "http://gcs-emulator:4443";

module.exports = function seed(domain) {
  const skillDir = path.resolve(process.cwd(), domain);

  // Check both files exist
  const manifestPath = path.join(skillDir, "manifest.json");
  const skillPath = path.join(skillDir, "skill.js");

  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: ${domain}/manifest.json not found.`);
    console.error("Run 'mpx-awa init' first to scaffold a skill.");
    process.exit(1);
  }
  if (!fs.existsSync(skillPath)) {
    console.error(`Error: ${domain}/skill.js not found.`);
    process.exit(1);
  }

  console.log(`Seeding skill "${domain}" to GCS emulator...`);
  console.log(`  Emulator: ${GCS_EMULATOR}`);

  // Upload manifest.json
  const manifestContent = fs.readFileSync(manifestPath, "utf-8");
  const manifestUrl = `${GCS_EMULATOR}/upload/storage/v1/b/awa-skills-dev/o?uploadType=media&name=user-scripts/${domain}/manifest.json`;

  httpUpload(manifestUrl, manifestContent, "application/json", (err) => {
    if (err) {
      console.error(`  ✗ Failed to upload manifest.json: ${err.message}`);
      process.exit(1);
    }
    console.log("  ✓ manifest.json");

    // Upload skill.js
    const skillContent = fs.readFileSync(skillPath, "utf-8");
    const skillUrl = `${GCS_EMULATOR}/upload/storage/v1/b/awa-skills-dev/o?uploadType=media&name=user-scripts/${domain}/skill.js`;

    httpUpload(skillUrl, skillContent, "application/javascript", (err2) => {
      if (err2) {
        console.error(`  ✗ Failed to upload skill.js: ${err2.message}`);
        process.exit(1);
      }
      console.log("  ✓ skill.js");
      console.log(`  ✅ Skill "${domain}" seeded successfully`);
    });
  });
};

/**
 * Simple HTTP upload via PUT.
 */
function httpUpload(url, data, contentType, callback) {
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname + urlObj.search,
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(data),
    },
    timeout: 10000,
  };

  const req = http.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        callback(null);
      } else {
        try {
          const parsed = JSON.parse(body);
          callback(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
        } catch {
          callback(new Error(`HTTP ${res.statusCode}`));
        }
      }
    });
  });

  req.on("error", callback);
  req.write(data);
  req.end();
}
