"use strict";

/**
 * mpx-awa list — List all skills in the MPX marketplace.
 *
 * Calls GET /v1/skills on the gateway and displays a table.
 *
 * Usage:
 *   mpx-awa list
 *   MPX_GATEWAY_URL=http://<gateway-host>:8080 mpx-awa list
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

module.exports = function listSkills(hostOpt) {
  const gatewayUrl = getGatewayUrl(hostOpt);
  const skillsUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/skills`;

  console.log(`Fetching marketplace skills from ${gatewayUrl}...\n`);

  apiGet(skillsUrl)
    .then((res) => {
      if (res.status !== 200) {
        const msg = res.body.error || `HTTP ${res.status}`;
        console.error(`  ✗ Failed to list skills: ${msg}`);
        process.exit(1);
      }

      const skills = res.body;
      if (!Array.isArray(skills) || skills.length === 0) {
        console.log("  No skills found in the marketplace.");
        return;
      }

      // Calculate column widths
      const idWidth = Math.max(...skills.map((s) => (s.id || "").length), 4);
      const titleWidth = Math.max(...skills.map((s) => (s.title || "").length), 5);
      const typeWidth = Math.max(...skills.map((s) => (s.skill_type || "").length), 4);
      const versionWidth = Math.max(...skills.map((s) => (s.current_version || "").length), 7);

      const line = (pad = " ") =>
        `  ${pad}${"─".repeat(idWidth + titleWidth + typeWidth + versionWidth + 9)}`;

      console.log(line());
      console.log(
        `  │ ${"ID".padEnd(idWidth)} │ ${"Title".padEnd(titleWidth)} │ ${"Type".padEnd(typeWidth)} │ ${"Version".padEnd(versionWidth)} │`
      );
      console.log(line("├"));

      for (const skill of skills) {
        console.log(
          `  │ ${(skill.id || "").padEnd(idWidth)} │ ${(skill.title || "").padEnd(titleWidth)} │ ${(skill.skill_type || "").padEnd(typeWidth)} │ ${(skill.current_version || "").padEnd(versionWidth)} │`
        );
      }

      console.log(line("└"));
      console.log(`  ${skills.length} skill(s) total.\n`);
    })
    .catch((err) => {
      console.error(`  ✗ Connection failed: ${err.message}`);
      process.exit(1);
    });
};
