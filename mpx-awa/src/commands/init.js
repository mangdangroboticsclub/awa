"use strict";

/**
 * mpx-awa init — Scaffolds a new AWA skill for a domain.
 *
 * Creates:
 *   ./<domain>/manifest.json  — Skill manifest (capabilities, URLs, action docs)
 *   ./<domain>/skill.js       — Handler implementations
 *   ./<domain>/GUIDE.md       — AWA script development guide
 */

const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");

module.exports = function init(domain) {
  const targetDir = path.resolve(process.cwd(), domain);

  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory "${domain}" already exists.`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`  ✓ Created directory: ${domain}/`);

  // -----------------------------------------------------------------------
  // Generate manifest.json
  // -----------------------------------------------------------------------
  const manifestPath = path.join(TEMPLATES_DIR, "manifest.json");
  let manifestContent = fs.readFileSync(manifestPath, "utf-8");
  manifestContent = manifestContent.replace(/{{DOMAIN}}/g, domain);

  const manifestOut = path.join(targetDir, "manifest.json");
  fs.writeFileSync(manifestOut, manifestContent, "utf-8");
  console.log(`  ✓ Created: ${domain}/manifest.json`);

  // -----------------------------------------------------------------------
  // Generate skill.js
  // -----------------------------------------------------------------------
  const skillTemplatePath = path.join(TEMPLATES_DIR, "skill.js");
  let skillContent = fs.readFileSync(skillTemplatePath, "utf-8");
  skillContent = skillContent.replace(/{{DOMAIN}}/g, domain);

  const skillPath = path.join(targetDir, "skill.js");
  fs.writeFileSync(skillPath, skillContent, "utf-8");
  console.log(`  ✓ Created: ${domain}/skill.js`);

  // -----------------------------------------------------------------------
  // Copy GUIDE.md
  // -----------------------------------------------------------------------
  const guideTemplatePath = path.join(TEMPLATES_DIR, "GUIDE.md");
  const guideContent = fs.readFileSync(guideTemplatePath, "utf-8");
  const guidePath = path.join(targetDir, "GUIDE.md");
  fs.writeFileSync(guidePath, guideContent, "utf-8");
  console.log(`  ✓ Created: ${domain}/GUIDE.md`);

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------
  console.log("");
  console.log(`  ✅ AWA skill scaffolded for "${domain}"`);
  console.log("");
  console.log("  Next steps:");
  console.log(`    cd ${domain}`);
  console.log("    # Edit manifest.json — set URL patterns, capabilities, README, and action docs");
  console.log("    # Edit skill.js — rename/implement the example handlers for your site");
  console.log("    # Read GUIDE.md for $awa.* API reference and best practices");
  console.log("    # Set the skill's README and verify action docs:");
  console.log(`    mpx-awa readme ${domain}`);
  console.log("    # Upload to GCS:");
  console.log(`    gcloud storage cp manifest.json gs://awa-skills-prod/user-scripts/${domain}/`);
  console.log(`    gcloud storage cp skill.js gs://awa-skills-prod/user-scripts/${domain}/`);
  console.log("");
};
