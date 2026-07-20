"use strict";

/**
 * mpx-awa init — Scaffolds a new AWA skill with interactive prompts.
 *
 * Usage:
 *   mpx-awa init <domain>
 *   mpx-awa init <slug>@<domain>       # Multiple skills for same domain
 *
 * Creates:
 *   ./<domain>/ or ./<slug>@<domain>/ directory
 *   manifest.json  — Skill manifest with guided defaults
 *   skill.js       — Handler implementations
 *   GUIDE.md       — AWA script development guide
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");

function prompt(question, defaultValue) {
  // If stdin is piped (not a TTY), skip prompts and return default
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue || "");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const hint = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`  ${question}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

module.exports = async function init(raw) {
  // Parse slug@domain format
  let slug, domain;
  const atIdx = raw.indexOf("@");
  if (atIdx > 0 && atIdx < raw.length - 1) {
    slug = raw.slice(0, atIdx);
    domain = raw.slice(atIdx + 1);
  } else {
    domain = raw;
    slug = null;
  }

  const targetDir = path.resolve(process.cwd(), raw);

  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory "${raw}" already exists.`);
    process.exit(1);
  }

  const defaultSlug = domain.replace(/\./g, "-").replace(/[^a-zA-Z0-9_-]/g, "");

  const STATE_FILE = path.join(os.homedir(), ".mpx-awa-state.json");

  console.log(`\n  📋 Scaffolding skill for "${raw}"\n`);

  // ── Interactive prompts (only user-facing config) ───────────────
  if (!slug) {
    slug = await prompt("Slug (short project identifier)", defaultSlug);
  }
  const title = await prompt("Title", `${domain} merchant skill`);

  // ── Check for slug collision against the gateway ──────────────
  const TOKEN_FILE = path.join(os.homedir(), ".mpx-awa-token");
  try {
    const token = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    if (token) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
        const username = payload.username;
        if (username) {
          const gatewayUrl = process.env.MPX_GATEWAY_URL || "http://localhost:8080";
          const checkUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/skills/check?slug=${encodeURIComponent(slug)}`;

          const httpMod = checkUrl.startsWith("https") ? require("https") : require("http");
          const resp = await new Promise((resolve, reject) => {
            const req = httpMod.get(checkUrl, {
              headers: { Authorization: `Bearer ${token}` },
              timeout: 5000,
            }, (res) => {
              let data = "";
              res.on("data", (c) => data += c);
              res.on("end", () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
              });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
          });

          if (resp && resp.exists) {
            console.warn(`\n  ⚠️  Warning: Slug "${slug}" is already taken by one of your skills.`);
            console.warn(`    Each slug must be unique across all your skills.`);
            console.warn(`    If you publish, this will conflict with the existing skill (${resp.skill_id}).`);
            console.warn(`    Pick a different slug, or use slug@domain format: e.g., "${slug}-carousell@${domain}"\n`);
          }
        }
      }
    }
  } catch {
    // No token, no state file — skip check, publish will catch it
  }
  // Hardcoded — mpx-awa only produces AWA/JS skills, version starts at 1.0.0
  const skillType = "AWA";
  const sourceLanguage = "javascript";
  const version = "1.0.0";

  // ── Create directory ──────────────────────────────────────────────
  fs.mkdirSync(targetDir, { recursive: true });

  // -----------------------------------------------------------------------
  // Generate manifest.json
  // -----------------------------------------------------------------------
  let manifestContent = fs.readFileSync(
    path.join(TEMPLATES_DIR, "manifest.json"), "utf-8",
  );
  manifestContent = manifestContent.replace(/{{DOMAIN}}/g, domain);
  manifestContent = manifestContent.replace(/{{SLUG}}/g, slug);
  manifestContent = manifestContent.replace(/{{VERSION}}/g, version);

  const manifestOut = path.join(targetDir, "manifest.json");
  fs.writeFileSync(manifestOut, manifestContent, "utf-8");

  // -----------------------------------------------------------------------
  // Generate skill.js
  // -----------------------------------------------------------------------
  let skillContent = fs.readFileSync(
    path.join(TEMPLATES_DIR, "skill.js"), "utf-8",
  );
  skillContent = skillContent.replace(/{{DOMAIN}}/g, domain);

  const skillOut = path.join(targetDir, "skill.js");
  fs.writeFileSync(skillOut, skillContent, "utf-8");

  // -----------------------------------------------------------------------
  // Copy GUIDE.md
  // -----------------------------------------------------------------------
  const guideContent = fs.readFileSync(
    path.join(TEMPLATES_DIR, "GUIDE.md"), "utf-8",
  );
  fs.writeFileSync(path.join(targetDir, "GUIDE.md"), guideContent, "utf-8");

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n  ✓ Created directory: ${raw}/`);
  console.log(`  ✓ Created: ${raw}/manifest.json`);
  console.log(`  ✓ Created: ${raw}/skill.js`);
  console.log(`  ✓ Created: ${raw}/GUIDE.md`);
  console.log(``);
  console.log(`  ✅ AWA skill scaffolded for "${raw}"`);
  console.log(``);
  console.log(`  Configuration:`);
  console.log(`    Slug:    ${slug}`);
  console.log(`    Title:   ${title}`);
  console.log(`    Version: 1.0.0`);
  console.log(``);
  console.log(`  Next steps:`);
  console.log(`    cd ${raw}`);
  console.log(`    # Edit skill.js — implement the handlers for your site`);
  console.log(`    # Read GUIDE.md for \\$awa.* API reference`);
  console.log(`    # Publish to the marketplace:`);
  console.log(`    mpx-awa login <username> <password>`);
  console.log(`    mpx-awa publish ${raw}`);
  console.log(``);
};
