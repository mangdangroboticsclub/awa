"use strict";

/**
 * mpx-awa readme — Display manifest metadata for a marketplace skill.
 *
 * By default outputs a human-friendly summary. Pass --json for raw JSON.
 *
 * Usage:
 *   mpx-awa readme <skill_id>
 *   mpx-awa readme <skill_id> --json
 *   mpx-awa readme <skill_id> --version v1.0.0
 *   mpx-awa readme <skill_id> --version v1.0.0 --json
 *   MPX_GATEWAY_URL=http://<gateway-host>:8080 mpx-awa readme haris_dev~my-scraper
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function wrapText(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + word).length > width) {
      if (current) lines.push(current.trim());
      current = word + " ";
    } else {
      current += word + " ";
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function formatHuman(m) {
  const lines = [];

  // ── Header ──────────────────────────────────────────────
  const name = m.title || m.name || m.skill_name || "Unknown Skill";
  lines.push(`✨ ${name}\n`);

  // ── Metadata ────────────────────────────────────────────
  if (m.domain) lines.push(`  Domain:    ${m.domain}`);
  if (m.slug) lines.push(`  Slug:      ${m.slug}`);
  const typeStr = [m.skill_type || m.type, m.source_language || m.language]
    .filter(Boolean)
    .join(" · ");
  if (typeStr) lines.push(`  Type:      ${typeStr}`);
  if (m.version) lines.push(`  Version:   ${m.version}`);
  if (m.author) lines.push(`  Author:    ${m.author}`);
  lines.push("");

  // ── Readme ──────────────────────────────────────────────
  const readmeText = m.readme || m.description || m.summary || "";
  if (readmeText) {
    lines.push(`  📖 Readme`);
    for (const l of wrapText(readmeText, 72)) {
      lines.push(`  ${l}`);
    }
    lines.push("");
  }

  // ── Capabilities ────────────────────────────────────────
  const caps = m.capabilities || m.endpoints || [];
  if (Array.isArray(caps) && caps.length > 0) {
    lines.push(`  🛠️ Capabilities (${caps.length})`);
    lines.push(`  ${caps.join(", ")}`);
    lines.push("");
  }

  // ── Actions ─────────────────────────────────────────────
  const actions = m.actions || {};
  const actionKeys = Object.keys(actions);
  if (actionKeys.length > 0) {
    lines.push(`  ⚡ Actions`);
    const maxNameLen = Math.max(...actionKeys.map((k) => k.length), 10);
    for (const key of actionKeys) {
      const act = actions[key];
      const desc =
        typeof act === "string"
          ? act
          : act.description || act.desc || "";
      const paddedKey = key.padEnd(maxNameLen + 2);
      lines.push(`  ${paddedKey}${desc}`);
    }
    lines.push("");
  }

  // ── URLs ────────────────────────────────────────────────
  const urls = m.urls || {};
  const urlKeys = Object.keys(urls);
  if (urlKeys.length > 0) {
    lines.push(`  🔗 URLs`);
    const maxKeyLen = Math.max(...urlKeys.map((k) => k.length), 8);
    for (const key of urlKeys) {
      lines.push(`  ${key.padEnd(maxKeyLen + 2)}${urls[key]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = async function readme(skillId, options = {}) {
  // options: { host, json, version }

  if (!skillId) {
    console.error(
      "Error: missing skill_id.\nUsage: mpx-awa readme <skill_id>"
    );
    process.exit(1);
  }

  const host = options.host || null;
  const jsonFlag = options.json === true;
  const versionOpt = options.version || null;

  const gatewayUrl = getGatewayUrl(host);
  let manifestUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/skills/${encodeURIComponent(skillId)}/manifest`;

  if (versionOpt) {
    manifestUrl += `?version=${encodeURIComponent(versionOpt)}`;
  }

  if (!jsonFlag) {
    console.log(
      `Fetching manifest for "${skillId}" from ${gatewayUrl}...\n`
    );
  }

  try {
    const res = await apiGet(manifestUrl);

    if (res.status === 404) {
      const detail = res.body.error || "skill or manifest not found";
      console.error(`  ✗ ${detail}`);
      process.exit(1);
    }
    if (res.status !== 200) {
      const msg = res.body.error || `HTTP ${res.status}`;
      console.error(`  ✗ Failed to fetch manifest: ${msg}`);
      process.exit(1);
    }

    if (jsonFlag) {
      // Raw JSON output (existing behavior)
      console.log(JSON.stringify(res.body, null, 2));
    } else {
      // Human-friendly output
      console.log(formatHuman(res.body));
    }
  } catch (err) {
    console.error(`  ✗ Connection failed: ${err.message}`);
    process.exit(1);
  }
};
