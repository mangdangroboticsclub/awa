"use strict";

/**
 * Seed Scripts — Uploads sample skill scripts to the GCS emulator.
 *
 * Usage:
 *   node scripts/seed-scripts.js
 *
 * This connects to the GCS emulator (or real GCS if GCS_ENDPOINT is unset)
 * and uploads the fixture scripts from tests/fixtures/scripts/ to the
 * configured bucket under user-scripts/<domain>.js.
 *
 * Environment variables:
 *   GCS_ENDPOINT   — GCS endpoint (set to emulator URL in dev)
 *   GCS_BUCKET     — Bucket name (default: awa-skills-dev)
 *   GCS_PROJECT_ID — GCP project ID (default: openclaw-dev)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");

const BUCKET = process.env.GCS_BUCKET || "awa-skills-dev";
const FIXTURES_DIR = path.join(__dirname, "..", "tests", "fixtures", "scripts");
const LOCAL_GCS_DIR = path.join(__dirname, "..", "data", "gcs", BUCKET, "user-scripts");

async function main() {
  console.log(`Seeding scripts to bucket: ${BUCKET}`);

  // Find all .js fixture files (except the fixture helper)
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".js") && f !== "screener-fixtures.js");

  if (fixtureFiles.length === 0) {
    console.log("No fixture scripts found to seed.");
    return;
  }

  // 1. Copy to local GCS data directory (for fake-gcs-server)
  console.log("\n--- Local GCS Emulator ---");
  fs.mkdirSync(LOCAL_GCS_DIR, { recursive: true });

  for (const file of fixtureFiles) {
    const srcPath = path.join(FIXTURES_DIR, file);
    const destPath = path.join(LOCAL_GCS_DIR, file);
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ Copied ${file} → ${destPath}`);
  }

  // 2. Upload to GCS emulator / real GCS
  const endpoint = process.env.GCS_ENDPOINT;
  if (endpoint) {
    console.log("\n--- GCS Emulator Upload ---");
    const storageOptions = {
      projectId: process.env.GCS_PROJECT_ID || "openclaw-dev",
      apiEndpoint: endpoint,
    };

    try {
      const storage = new Storage(storageOptions);
      const bucket = storage.bucket(BUCKET);

      for (const file of fixtureFiles) {
        const srcPath = path.join(FIXTURES_DIR, file);
        const destKey = `user-scripts/${file}`;
        await bucket.upload(srcPath, { destination: destKey });
        console.log(`  ✓ Uploaded ${file} → gs://${BUCKET}/${destKey}`);
      }
    } catch (err) {
      console.error(`  ✗ GCS upload failed: ${err.message}`);
      console.log("  (Local copies were still written to data/gcs/)");
    }
  } else {
    console.log("\n(GCS_ENDPOINT not set — skipping GCS upload)");
  }

  console.log("\nDone. Scripts are ready for the worker to fetch.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
