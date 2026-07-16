"use strict";

/**
 * mpx-awa list — List all seeded skills in the GCS bucket.
 *
 * Queries the GCS emulator (or real GCS) for objects under user-scripts/
 * and extracts unique domain names.
 *
 * Usage: mpx-awa list
 */

const http = require("http");

const GCS_EMULATOR = process.env.GCS_EMULATOR_URL || "http://localhost:4443";
const BUCKET = process.env.GCS_BUCKET || "awa-skills-dev";

module.exports = function listSkills() {
  console.log(`Fetching skills from GCS bucket "${BUCKET}"...`);
  console.log(`  Emulator: ${GCS_EMULATOR}`);
  console.log("");

  const listUrl = `${GCS_EMULATOR}/storage/v1/b/${BUCKET}/o?prefix=user-scripts/`;

  httpGet(listUrl, (err, body) => {
    if (err) {
      console.error(`  ✗ Failed to list skills: ${err.message}`);
      process.exit(1);
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      console.error("  ✗ Invalid response from GCS emulator");
      process.exit(1);
    }

    const items = data.items || [];
    if (items.length === 0) {
      console.log("  No skills found in bucket.");
      return;
    }

    // Extract unique domain names from object paths like
    // "user-scripts/bestbuy.com/manifest.json"
    const domains = new Set();
    for (const item of items) {
      const match = item.name.match(/^user-scripts\/([^/]+)\//);
      if (match) domains.add(match[1]);
    }

    const sorted = [...domains].sort();

    console.log(`  Found ${sorted.length} skill(s):\n`);
    for (const domain of sorted) {
      const hasManifest = items.some(
        (i) => i.name === `user-scripts/${domain}/manifest.json`
      );
      const hasScript = items.some(
        (i) => i.name === `user-scripts/${domain}/skill.js`
      );

      const files = [];
      if (hasManifest) files.push("manifest.json");
      if (hasScript) files.push("skill.js");
      console.log(`  ${domain}`);
      console.log(`    Files: ${files.join(", ")}`);
      console.log("");
    }
  });
};

/**
 * Simple HTTP GET.
 */
function httpGet(url, callback) {
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname + urlObj.search,
    method: "GET",
    timeout: 10000,
  };

  const req = http.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        callback(null, body);
      } else {
        callback(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      }
    });
  });

  req.on("error", callback);
  req.end();
}
