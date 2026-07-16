"use strict";

/**
 * mpx-awa readme — Display or update the README/help text for a skill.
 *
 * Each skill's manifest.json can include:
 *   - "readme": free-form description of the skill
 *   - "actions": structured documentation for each action with param/return/example
 *
 * Commands:
 *   mpx-awa readme <domain>              Show the skill's full README + action docs
 *   mpx-awa readme <domain> --set "<text>"  Set/update the free-form README
 *   mpx-awa readme <domain> --json      Show raw manifest JSON (for programmatic use)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const GCS_EMULATOR = process.env.GCS_EMULATOR_URL || "http://localhost:4443";
const BUCKET = process.env.GCS_BUCKET || "awa-skills-dev";

module.exports = function readme(domain, options) {
  if (typeof options === "string") {
    return setReadme(domain, options, false);
  }
  if (options && options.json) {
    return showRawManifest(domain);
  }
  return showReadme(domain);
};

// ─── Show readme with action docs ───────────────────────────────────────────

function showReadme(domain) {
  console.log(`Fetching skill documentation for "${domain}"...`);
  console.log(`  Bucket: ${BUCKET}, Emulator: ${GCS_EMULATOR}`);
  console.log("");

  const manifestUrl = `${GCS_EMULATOR}/storage/v1/b/${BUCKET}/o/${encodeURIComponent("user-scripts/" + domain + "/manifest.json")}?alt=media`;

  httpGet(manifestUrl, (err, body) => {
    if (err) {
      console.error(`  ✗ Failed to fetch manifest: ${err.message}`);
      console.error("    Make sure the skill is seeded.");
      process.exit(1);
    }

    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch {
      console.error("  ✗ Invalid manifest JSON");
      process.exit(1);
    }

    // ── Free-form README ──
    const readme = manifest.readme || manifest.description || "";
    if (readme) {
      console.log("  ── README ──");
      console.log("");
      const indented = readme
        .split("\n")
        .map((line) => "  " + line)
        .join("\n");
      console.log(indented);
      console.log("");
    } else {
      console.log("  ℹ️  No free-form README set.");
      console.log(`     Set one: mpx-awa readme ${domain} --set "Your description here"`);
      console.log("");
    }

    // ── Structured action docs ──
    const actions = manifest.actions || {};
    const actionKeys = Object.keys(actions);
    if (actionKeys.length > 0) {
      console.log("  ── Actions ──");
      console.log("");
      for (const [name, action] of Object.entries(actions)) {
        console.log(`  ${name}`);
        if (action.description) console.log(`    ${action.description}`);

        // Params
        const params = action.params || {};
        const paramKeys = Object.keys(params);
        if (paramKeys.length > 0) {
          console.log("    Params:");
          for (const [pName, pInfo] of Object.entries(params)) {
            const req = pInfo.required ? "required" : "optional";
            console.log(`      ${pName}  (${pInfo.type}, ${req})`);
            if (pInfo.description) console.log(`        ${pInfo.description}`);
          }
        } else {
          console.log("    Params: none");
        }

        // Returns
        const returns = action.returns || {};
        const retKeys = Object.keys(returns);
        if (retKeys.length > 0) {
          console.log("    Returns:");
          for (const [rName, rDesc] of Object.entries(returns)) {
            console.log(`      ${rName}: ${rDesc}`);
          }
        }

        // Example(s)
        const examples = action.examples || (action.example ? [action.example] : []);
        for (const ex of examples) {
          if (ex.title) {
            console.log(`    Example — ${ex.title}:`);
          } else {
            console.log("    Example:");
          }
          if (ex.params && Object.keys(ex.params).length > 0) {
            console.log(`      Input:  ${JSON.stringify(ex.params)}`);
          }
          if (ex.result) {
            console.log(`      Result: ${JSON.stringify(ex.result)}`);
          }
        }
        console.log("");
      }
    }

    // ── Capabilities summary ──
    console.log("  ── Capabilities ──");
    console.log("    " + (manifest.capabilities || []).join(", "));

    if (manifest.urls) {
      console.log("");
      console.log("  ── URLs ──");
      for (const [key, url] of Object.entries(manifest.urls)) {
        console.log(`    ${key}: ${url}`);
      }
    }

    console.log("");
    console.log(`  Version: ${manifest.version || "—"}`);
    console.log(`  Timeout: ${manifest.timeout || 30000}ms, Memory: ${manifest.memoryLimitMB || 128}MB`);
  });
}

// ─── Raw JSON output ────────────────────────────────────────────────────────

function showRawManifest(domain) {
  const manifestUrl = `${GCS_EMULATOR}/storage/v1/b/${BUCKET}/o/${encodeURIComponent("user-scripts/" + domain + "/manifest.json")}?alt=media`;

  httpGet(manifestUrl, (err, body) => {
    if (err) {
      console.error(`  ✗ Failed to fetch manifest: ${err.message}`);
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(body);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.error("  ✗ Invalid manifest JSON");
      process.exit(1);
    }
  });
}

// ─── Set readme ─────────────────────────────────────────────────────────────

function setReadme(domain, text, isJson) {
  const skillDir = path.resolve(process.cwd(), domain);
  const manifestPath = path.join(skillDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: ${domain}/manifest.json not found locally.`);
    console.error("Run 'mpx-awa init' first or 'mpx-awa readme <domain>' to view without editing.");
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    console.error(`Error: Could not parse ${domain}/manifest.json`);
    process.exit(1);
  }

  manifest.readme = text;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`  ✓ Updated readme in ${domain}/manifest.json`);
  console.log("");
  console.log("  Now re-seed to update GCS:");
  console.log(`    mpx-awa seed ${domain}`);
  console.log("");

  console.log("  ── Readme preview ──");
  console.log(text);
  console.log("  ────────────────────");
}

// ─── HTTP helper ────────────────────────────────────────────────────────────

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
