"use strict";

/**
 * mpx-awa delete — Delete a seeded skill domain from the GCS bucket.
 *
 * Removes both manifest.json and skill.js (and any other files) for
 * the given domain from the GCS emulator.
 *
 * Usage: mpx-awa delete <domain>
 */

const http = require("http");

const GCS_EMULATOR = process.env.GCS_EMULATOR_URL || "http://localhost:4443";
const BUCKET = process.env.GCS_BUCKET || "awa-skills-dev";

module.exports = function deleteSkill(domain) {
  console.log(`Deleting skill "${domain}" from GCS bucket "${BUCKET}"...`);
  console.log(`  Emulator: ${GCS_EMULATOR}`);

  // First list objects for this domain so we know what to delete
  const listUrl = `${GCS_EMULATOR}/storage/v1/b/${BUCKET}/o?prefix=user-scripts/${encodeURIComponent(domain)}/`;

  httpGet(listUrl, (err, body) => {
    if (err) {
      console.error(`  ✗ Failed to list objects: ${err.message}`);
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
      console.log(`  No objects found for domain "${domain}". Nothing to delete.`);
      return;
    }

    const names = items.map((i) => i.name);
    console.log(`  Found ${names.length} object(s) to delete:`);
    names.forEach((n) => console.log(`    - ${n}`));

    // Delete each object sequentially
    let completed = 0;
    let hasError = false;

    for (const name of names) {
      const encodedName = name.split("/").map(encodeURIComponent).join("/");
      const deleteUrl = `${GCS_EMULATOR}/storage/v1/b/${BUCKET}/o/${encodedName}`;

      httpDelete(deleteUrl, (delErr) => {
        if (delErr) {
          console.error(`  ✗ Failed to delete "${name}": ${delErr.message}`);
          hasError = true;
        } else {
          console.log(`  ✓ Deleted: ${name}`);
        }

        completed++;
        if (completed === names.length) {
          if (!hasError) {
            console.log(`  ✅ Skill "${domain}" deleted successfully`);
          } else {
            console.log(`  ⚠️  Skill "${domain}" partially deleted (some objects may remain)`);
            process.exit(1);
          }
        }
      });
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

/**
 * Simple HTTP DELETE.
 */
function httpDelete(url, callback) {
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname + urlObj.search,
    method: "DELETE",
    timeout: 10000,
  };

  const req = http.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        callback(null);
      } else {
        callback(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      }
    });
  });

  req.on("error", callback);
  req.end();
}
