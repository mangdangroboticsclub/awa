"use strict";

/**
 * mpx-awa publish — Publish a skill to the MPX marketplace.
 *
 * Usage:
 *   mpx-awa publish <domain>
 *   MPX_GATEWAY_URL=http://<gateway-host>:8080 mpx-awa publish amazon.com
 *
 * Requires a valid token stored by `mpx-awa login` at ~/.mpx-awa-token.
 *
 * The skill_id is constructed as {username}~{slug}, where:
 *   - username is read from the stored JWT (READ-ONLY, set by login)
 *   - slug is read from manifest.json, LOCKED after first publish per domain
 *     (change slug → creates a new skill; the lock prevents accidental duplicates)
 *
 * If the gateway rejects the version (must increment), offers to
 * auto-bump patch/minor/major and retry.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const TOKEN_FILE = path.join(os.homedir(), ".mpx-awa-token");
const STATE_FILE = path.join(os.homedir(), ".mpx-awa-state.json");


/** Read the local publish state (domain → skill_id mapping). */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the local publish state. */
function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Check if the slug changed from the first publish for this domain.
 * On first publish, record it. On later publishes, enforce the lock.
 */
function checkSlugLock(domain, username, slug) {
  const state = readState();
  const key = `${username}~${domain}`;
  const existing = state[key];

  if (existing && existing !== slug) {
    console.error(`\n  ✗ Slug locked! This domain was first published with slug "${existing}".`);
    console.error(`    The current manifest has slug "${slug}".`);
    console.error(`    To create a different skill, use a different directory.`);
    console.error(`    To update the existing skill, restore the slug to "${existing}" in manifest.json.\n`);
    process.exit(1);
  }

  return { state, key };
}

/** Record a successful publish's slug lock. */
function recordSlugLock(domain, username, slug) {
  const state = readState();
  const key = `${username}~${domain}`;
  state[key] = slug;
  writeState(state);
}


function getGatewayUrl(hostOpt) {
  return hostOpt || process.env.MPX_GATEWAY_URL || "http://localhost:8080";
}

function getToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Decode the username from the JWT payload (without verifying the signature).
 * The JWT payload is base64-encoded JSON and is publicly readable.
 */
function getUsernameFromToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.username || null;
  } catch {
    return null;
  }
}

/** Parse semver string into parts */
function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

/** Bump helpers */
function bumpPatch(v)  { const p = parseSemver(v); return `${p.major}.${p.minor}.${p.patch + 1}`; }
function bumpMinor(v)  { const p = parseSemver(v); return `${p.major}.${p.minor + 1}.0`; }
function bumpMajor(v)  { const p = parseSemver(v); return `${p.major + 1}.0.0`; }

function apiPost(url, jsonBody, token) {
  const urlObj = new URL(url);
  const body = JSON.stringify(jsonBody);
  const mod = urlObj.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers,
      timeout: 30000,
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
    req.write(body);
    req.end();
  });
}

function askBump(currentVersion) {
  const p = parseSemver(currentVersion);
  if (!p) return Promise.resolve(null);

  // If stdin is piped (not a TTY), skip interactive prompt
  if (!process.stdin.isTTY) {
    return Promise.resolve(bumpPatch(currentVersion));
  }

  const choices = [
    { key: 1, label: `Patch (${bumpPatch(currentVersion)})`, desc: "Bug fixes, internal adjustments", value: bumpPatch(currentVersion) },
    { key: 2, label: `Minor (${bumpMinor(currentVersion)})`, desc: "New features, backward-compatible", value: bumpMinor(currentVersion) },
    { key: 3, label: `Major (${bumpMajor(currentVersion)})`, desc: "Breaking changes", value: bumpMajor(currentVersion) },
    { key: 0, label: "Cancel", desc: "", value: null },
  ];

  return new Promise((resolve) => {
    console.log(`\n  📈 Select the release type for this update:\n`);
    for (const c of choices) {
      if (c.value !== null) {
        console.log(`    ${c.key}) ${c.label.padEnd(14)} — ${c.desc}`);
      }
    }
    console.log(`    0) Cancel\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  Choice [0-3]: ", (answer) => {
      rl.close();
      const num = parseInt(answer, 10);
      const choice = choices.find((c) => c.key === num);
      resolve(choice ? choice.value : null);
    });
  });
}

function doPublish(domain, hostOpt, manifest, { artifactContent, artifactB64, skillId, slug, version }) {
  const gatewayUrl = getGatewayUrl(hostOpt);
  const publishUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/publish`;

  // Override manifest with READ-ONLY values before sending
  const enforcedManifest = { ...manifest, skill_type: "AWA", source_language: "javascript" };

  const payload = {
    skill_id: skillId,
    title: manifest.title || domain,
    skill_type: "AWA",        // READ-ONLY — mpx-awa only produces AWA skills
    source_language: "javascript", // READ-ONLY — only supported language
    version,
    artifact: artifactB64,
    manifest: enforcedManifest,
  };

  console.log(`\n  🔒 Verifying marketplace authorization... Connected as ${skillId.split("~")[0]}.`);
  console.log(`  📦 Publishing v${version} (${artifactContent.length} bytes)...`);

  return apiPost(publishUrl, payload, getToken())
    .then((res) => {
      if (res.status === 200 || res.status === 201) {
        const p = res.body.path;
        console.log(`  ✅ Success! Published v${res.body.version}`);
        console.log(`  📍 gs://mpx-marketplace-artifacts/${p}`);
        return true;
      }

      if (res.status === 409 && res.body.current_version) {
        return { conflict: true, currentVersion: res.body.current_version };
      }

      const msg = res.body.error || `HTTP ${res.status}`;
      console.error(`  ✗ Publish failed: ${msg}`);
      return false;
    });
}

module.exports = async function publish(domain, hostOpt) {
  const token = getToken();
  if (!token) {
    console.error("\n  🔒 No auth token found. Run 'mpx-awa login' first.\n");
    process.exit(1);
  }

  const username = getUsernameFromToken(token);
  if (!username) {
    console.error("\n  ✗ Invalid or malformed token. Run 'mpx-awa login' again.\n");
    process.exit(1);
  }

  const skillDir = path.resolve(process.cwd(), domain);
  const manifestPath = path.join(skillDir, "manifest.json");
  const skillPath = path.join(skillDir, "skill.js");

  if (!fs.existsSync(manifestPath)) {
    console.error(`  ✗ ${domain}/manifest.json not found. Run 'mpx-awa init' first.`);
    process.exit(1);
  }
  if (!fs.existsSync(skillPath)) {
    console.error(`  ✗ ${domain}/skill.js not found.`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.error(`  ✗ Failed to parse ${domain}/manifest.json: ${err.message}`);
    process.exit(1);
  }

  // Slug is set once at init — stored in manifest.json.
  // Changing it creates a NEW skill for the same domain (multiple skills per domain).
  // The original skill_id remains locked in the marketplace.
  const slug = manifest.slug || domain;
  const skillId = `${username}~${slug}`;
  const skillType = "AWA";  // READ-ONLY — mpx-awa only produces AWA skills

  // Check slug lock — reject if this domain was previously published with a different slug
  const { state: _state, key: _key } = checkSlugLock(domain, username, slug);

  const artifactContent = fs.readFileSync(skillPath);
  const artifactB64 = artifactContent.toString("base64");

  const common = { artifactContent, artifactB64, skillId, slug, domain };

  // ── First attempt ─────────────────────────────────────────────
  let version = (manifest.version || "1.0.0").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`  ✗ Invalid version "${version}". Must be semver (X.Y.Z).`);
    process.exit(1);
  }

  let result = await doPublish(domain, hostOpt, manifest, { ...common, version });

  // ── Handle version conflict or slug collision ─────────────────
  while (result && result.conflict) {
    const current = result.currentVersion;

    // Check if this is a slug collision (no local state entry) vs. genuine version conflict
    const stateKey = `${username}~${domain}`;
    const state = readState();

    if (!state[stateKey]) {
      // Slug collision — this slug is taken by another skill
      console.error(`\n  ✗ Slug "${slug}" is already taken — you already published a different skill with this slug.`);
      console.error(`    Each slug must be unique across all your skills.`);
      console.error(`    Pick a more specific slug next time: e.g., "${slug}-carousell"`);
      console.error(`    Note: the existing skill still exists as "${skillId}".\n`);
      process.exit(1);
    }

    // Genuine version conflict — offer auto-bump
    console.log(`  ⚠️  Remote conflict: v${current} is already live.`);

    const newVersion = await askBump(current);
    if (!newVersion) {
      console.log("  Cancelled.");
      process.exit(0);
    }

    // Update manifest on disk
    manifest.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`  📝 Updated manifest.json: version → ${newVersion}`);

    version = newVersion;
    result = await doPublish(domain, hostOpt, manifest, { ...common, version });
  }

  // Record slug lock on successful first publish
  if (result === true) {
    recordSlugLock(domain, username, slug);
  }

  if (!result) {
    process.exit(1);
  }
};
