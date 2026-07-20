"use strict";

/**
 * mpx-awa versions — List all versions of a marketplace skill.
 *
 * Calls GET /v1/skills/{skill_id}/versions on the gateway.
 *
 * Usage:
 *   mpx-awa versions <skill_id>
 *   MPX_GATEWAY_URL=http://<gateway-host>:8080 mpx-awa versions haris_dev~my-scraper
 *
 * Supported flags (before subcommand):
 *   --gateway <url>   Override the gateway URL
 */

const https = require("https");
const http = require("http");

function getGatewayUrl(hostOpt) {
  return hostOpt || process.env.MPX_GATEWAY_URL || "http://localhost:8080";
}

function apiGet(url) {
  const urlObj = new URL(url);
  const mod = urlObj.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout: 15000,
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

module.exports = function listVersions(skillId, hostOpt) {
  if (!skillId) {
    console.error("Error: missing skill_id.\nUsage: mpx-awa versions <skill_id>");
    process.exit(1);
  }

  const gatewayUrl = getGatewayUrl(hostOpt);
  const versionsUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/skills/${encodeURIComponent(skillId)}/versions`;

  console.log(`Fetching versions for "${skillId}" from ${gatewayUrl}...\n`);

  apiGet(versionsUrl)
    .then((res) => {
      if (res.status === 404) {
        console.error(`  ✗ Skill "${skillId}" not found.`);
        process.exit(1);
      }
      if (res.status !== 200) {
        const msg = res.body.error || `HTTP ${res.status}`;
        console.error(`  ✗ Failed to fetch versions: ${msg}`);
        process.exit(1);
      }

      const versions = res.body;
      if (!Array.isArray(versions) || versions.length === 0) {
        console.log(`  No versions found for "${skillId}".`);
        return;
      }

      console.log(`  ${versions.length} version(s) for "${skillId}":\n`);

      for (const v of versions) {
        console.log(`    ${v.version}`);
        console.log(`      Path: ${v.gcs_artifact_path || "—"}`);
        console.log(`      Created: ${v.created_at || "—"}`);
        console.log("");
      }
    })
    .catch((err) => {
      console.error(`  ✗ Connection failed: ${err.message}`);
      process.exit(1);
    });
};
